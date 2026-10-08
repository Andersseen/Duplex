import { Injectable, signal } from '@angular/core';
import {
  FILE_TRANSFER_PROTOCOL_VERSION,
  MAX_FILE_TRANSFER_BYTES,
  MAX_TRANSFER_FILENAME_LENGTH,
  fileTransferMessageSchema,
} from '@duplex/protocol';
import type { FileTransferMessage } from '@duplex/protocol';
import type { DuplexDataChannel } from '@duplex/webrtc';

const CHUNK_SIZE = 16 * 1024;
const BUFFERED_AMOUNT_HIGH_WATER = 1024 * 1024;

export type TransferState =
  | 'offered'
  | 'waiting-for-acceptance'
  | 'queued'
  | 'transferring'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed';

export interface TransferView {
  readonly id: string;
  readonly direction: 'sending' | 'receiving';
  readonly name: string;
  readonly size: number;
  readonly bytes: number;
  readonly state: TransferState;
  readonly error?: string;
}

interface QueuedFile {
  readonly file: File;
  readonly id: string;
}

interface IncomingTransfer {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly chunks: ArrayBuffer[];
  bytes: number;
}

@Injectable()
export class FileTransferService {
  readonly transfers = signal<TransferView[]>([]);
  private channel: DuplexDataChannel | null = null;
  private channelUnsubscribe: (() => void) | null = null;
  private readonly queue: QueuedFile[] = [];
  private readonly cancelledOutgoing = new Set<string>();
  private activeOutgoing: QueuedFile | null = null;
  private incoming: IncomingTransfer | null = null;
  private readonly blobs = new Map<string, Blob>();
  private readonly objectUrls = new Map<string, string>();

  attachChannel(channel: DuplexDataChannel | null): void {
    if (this.channel === channel) return;
    this.detachChannel();
    if (!channel) return;
    this.channel = channel;
    this.channelUnsubscribe = channel.subscribe((event) => {
      if (event.type === 'open') this.pumpQueue();
      else if (event.type === 'message') {
        if (typeof event.data === 'string') this.onControl(event.data);
        else this.onBinary(event.data);
      } else this.detachChannel();
    });
    this.pumpQueue();
  }

  sendFiles(files: readonly File[]): void {
    for (const file of files) {
      const id = crypto.randomUUID();
      const name = this.safeFilename(file.name);
      if (!name || file.size > MAX_FILE_TRANSFER_BYTES) {
        this.upsert({
          id,
          direction: 'sending',
          name: name || 'Invalid filename',
          size: file.size,
          bytes: 0,
          state: 'failed',
          error:
            file.size > MAX_FILE_TRANSFER_BYTES
              ? 'Files must be 256 MiB or smaller.'
              : 'This filename is not valid.',
        });
        continue;
      }
      this.queue.push({ file, id });
      this.upsert({ id, direction: 'sending', name, size: file.size, bytes: 0, state: 'queued' });
    }
    this.pumpQueue();
  }

  accept(id: string): void {
    const incoming = this.incoming;
    if (incoming?.id !== id || this.channel?.state !== 'open') return;
    this.update(id, { state: 'transferring' });
    this.sendControl({
      type: 'file-accept',
      transferId: id,
      protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
    });
  }

  decline(id: string): void {
    if (this.incoming?.id !== id) return;
    this.update(id, { state: 'rejected' });
    this.incoming = null;
    this.sendControl({
      type: 'file-reject',
      transferId: id,
      protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
    });
  }

  cancel(id: string): void {
    const queuedIndex = this.queue.findIndex((item) => item.id === id);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.update(id, { state: 'cancelled' });
      return;
    }
    if (this.activeOutgoing?.id === id) {
      if (this.view(id)?.state === 'transferring') this.cancelledOutgoing.add(id);
      this.sendControl({
        type: 'file-cancel',
        transferId: id,
        protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
      });
      this.activeOutgoing = null;
      this.update(id, { state: 'cancelled' });
      this.pumpQueue();
      return;
    }
    if (this.incoming?.id === id) {
      this.incoming = null;
      this.update(id, { state: 'cancelled' });
      this.sendControl({
        type: 'file-cancel',
        transferId: id,
        protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
      });
      this.releaseBlob(id);
    }
  }

  downloadUrl(id: string): string | null {
    const blob = this.blobs.get(id);
    if (!blob) return null;
    let url = this.objectUrls.get(id);
    if (!url) {
      url = URL.createObjectURL(blob);
      this.objectUrls.set(id, url);
    }
    return url;
  }

  dismiss(id: string): void {
    this.releaseBlob(id);
    this.transfers.update((items) => items.filter((item) => item.id !== id));
  }

  peerChanged(): void {
    this.detachChannel();
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.blobs.clear();
    this.transfers.update((items) =>
      items.filter((item) => item.state !== 'completed' || item.direction !== 'receiving'),
    );
  }

  destroy(): void {
    this.detachChannel();
    this.queue.length = 0;
    this.activeOutgoing = null;
    this.incoming = null;
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.blobs.clear();
    this.transfers.set([]);
  }

  private detachChannel(): void {
    this.channelUnsubscribe?.();
    this.channelUnsubscribe = null;
    this.channel = null;
    if (this.activeOutgoing) {
      this.update(this.activeOutgoing.id, {
        state: 'failed',
        error: 'The peer connection closed.',
      });
      this.activeOutgoing = null;
    }
    for (const queued of this.queue.splice(0))
      this.update(queued.id, { state: 'failed', error: 'The peer connection closed.' });
    if (this.incoming) {
      this.update(this.incoming.id, { state: 'failed', error: 'The peer connection closed.' });
      this.releaseBlob(this.incoming.id);
      this.incoming = null;
    }
  }

  private onControl(raw: string): void {
    let parsed: ReturnType<typeof fileTransferMessageSchema.safeParse>;
    try {
      parsed = fileTransferMessageSchema.safeParse(JSON.parse(raw) as unknown);
    } catch {
      this.channel?.close();
      return;
    }
    if (!parsed.success) {
      this.channel?.close();
      return;
    }
    const message = parsed.data;
    if (message.type === 'file-offer') {
      if (this.incoming || message.size > MAX_FILE_TRANSFER_BYTES) {
        this.sendControl({
          type: 'file-reject',
          transferId: message.transferId,
          protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
        });
        return;
      }
      const name = this.safeFilename(message.name);
      if (!name) {
        this.sendControl({
          type: 'file-reject',
          transferId: message.transferId,
          protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
        });
        return;
      }
      this.incoming = {
        id: message.transferId,
        name,
        size: message.size,
        mimeType: message.mimeType,
        chunks: [],
        bytes: 0,
      };
      this.upsert({
        id: message.transferId,
        direction: 'receiving',
        name,
        size: message.size,
        bytes: 0,
        state: 'offered',
      });
      return;
    }
    if (this.activeOutgoing?.id === message.transferId) {
      if (message.type === 'file-accept') {
        this.update(message.transferId, { state: 'transferring' });
        void this.sendActiveFile(this.activeOutgoing);
      } else if (message.type === 'file-reject') {
        this.update(message.transferId, { state: 'rejected' });
        this.activeOutgoing = null;
        this.pumpQueue();
      } else if (message.type === 'file-complete') {
        const item = this.activeOutgoing;
        this.update(message.transferId, { bytes: item.file.size, state: 'completed' });
        this.activeOutgoing = null;
        this.pumpQueue();
      } else {
        this.update(message.transferId, {
          state: message.type === 'file-cancel' ? 'cancelled' : 'failed',
          ...(message.type === 'file-error'
            ? { error: 'The peer could not receive this file.' }
            : {}),
        });
        this.activeOutgoing = null;
        this.pumpQueue();
      }
      return;
    }
    if (this.incoming?.id === message.transferId) {
      if (message.type === 'file-cancel' || message.type === 'file-error') {
        const id = this.incoming.id;
        this.incoming = null;
        this.update(id, {
          state: message.type === 'file-cancel' ? 'cancelled' : 'failed',
          ...(message.type === 'file-error' ? { error: 'The peer could not send this file.' } : {}),
        });
        this.releaseBlob(id);
      } else if (message.type === 'file-complete') this.finishIncoming();
    }
  }

  private onBinary(data: ArrayBuffer): void {
    const incoming = this.incoming;
    if (!incoming || this.view(incoming.id)?.state !== 'transferring') return;
    if (incoming.bytes + data.byteLength > incoming.size) {
      this.sendControl({
        type: 'file-error',
        transferId: incoming.id,
        protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
        reason: 'invalid',
      });
      this.failIncoming('Received more bytes than the offer declared.');
      return;
    }
    incoming.chunks.push(data);
    incoming.bytes += data.byteLength;
    this.update(incoming.id, { bytes: incoming.bytes });
  }

  private finishIncoming(): void {
    const incoming = this.incoming;
    if (!incoming) return;
    if (incoming.bytes !== incoming.size) {
      this.failIncoming('The received file size did not match the offer.');
      return;
    }
    const blob = new Blob(incoming.chunks, { type: incoming.mimeType });
    this.blobs.set(incoming.id, blob);
    this.update(incoming.id, { state: 'completed', bytes: incoming.bytes });
    this.incoming = null;
    this.sendControl({
      type: 'file-complete',
      transferId: incoming.id,
      protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
    });
  }

  private failIncoming(error: string): void {
    if (!this.incoming) return;
    const id = this.incoming.id;
    this.incoming = null;
    this.update(id, { state: 'failed', error });
    this.releaseBlob(id);
  }

  private pumpQueue(): void {
    if (this.activeOutgoing || this.channel?.state !== 'open') return;
    const next = this.queue.shift();
    if (!next) return;
    this.activeOutgoing = next;
    this.update(next.id, { state: 'waiting-for-acceptance' });
    this.sendControl({
      type: 'file-offer',
      transferId: next.id,
      protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
      name: this.safeFilename(next.file.name),
      size: next.file.size,
      mimeType: next.file.type.slice(0, 128),
    });
  }

  private async sendActiveFile(item: QueuedFile): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    let bytes = 0;
    try {
      while (
        bytes < item.file.size &&
        this.activeOutgoing?.id === item.id &&
        !this.cancelledOutgoing.has(item.id)
      ) {
        if (channel.state !== 'open') throw new Error('The peer connection closed.');
        while (channel.bufferedAmount > BUFFERED_AMOUNT_HIGH_WATER) {
          await channel.waitForBufferedAmountLow();
          if (this.cancelledOutgoing.has(item.id)) {
            this.cancelledOutgoing.delete(item.id);
            return;
          }
        }
        const data = await item.file
          .slice(bytes, Math.min(bytes + CHUNK_SIZE, item.file.size))
          .arrayBuffer();
        if (this.cancelledOutgoing.has(item.id)) {
          this.cancelledOutgoing.delete(item.id);
          return;
        }
        channel.sendBinary(data);
        bytes += data.byteLength;
        this.update(item.id, { bytes, state: 'transferring' });
      }
      this.cancelledOutgoing.delete(item.id);
      if (this.activeOutgoing?.id === item.id && !this.cancelledOutgoing.has(item.id))
        this.sendControl({
          type: 'file-complete',
          transferId: item.id,
          protocolVersion: FILE_TRANSFER_PROTOCOL_VERSION,
        });
    } catch {
      if (this.activeOutgoing?.id !== item.id) return;
      this.update(item.id, { state: 'failed', error: 'The peer connection closed.' });
      this.activeOutgoing = null;
      this.pumpQueue();
    }
  }

  private sendControl(message: FileTransferMessage): void {
    try {
      if (this.channel?.state === 'open') this.channel.sendText(JSON.stringify(message));
    } catch {
      this.detachChannel();
    }
  }

  private safeFilename(value: string): string {
    const basename = value.replaceAll('\\', '/').split('/').at(-1) ?? '';
    const clean = Array.from(basename)
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      })
      .join('');
    return clean.slice(0, MAX_TRANSFER_FILENAME_LENGTH).trim();
  }

  private view(id: string): TransferView | undefined {
    return this.transfers().find((item) => item.id === id);
  }

  private update(id: string, patch: Partial<TransferView>): void {
    this.transfers.update((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  private upsert(transfer: TransferView): void {
    this.transfers.update((items) => [
      ...items.filter((item) => item.id !== transfer.id),
      transfer,
    ]);
  }

  private releaseBlob(id: string): void {
    this.blobs.delete(id);
    const url = this.objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.objectUrls.delete(id);
  }
}
