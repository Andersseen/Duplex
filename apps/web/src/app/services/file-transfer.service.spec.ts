import { describe, expect, it, vi } from 'vitest';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';
import { FileTransferService } from './file-transfer.service';

class FakeChannel implements DuplexDataChannel {
  readonly label = 'duplex-file-transfer' as const;
  state: DuplexDataChannel['state'] = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 256 * 1024;
  peer: FakeChannel | null = null;
  waitCount = 0;
  private listeners = new Set<(event: DuplexDataChannelEvent) => void>();

  sendText(data: string): void {
    this.peer?.emit({ type: 'message', data });
  }
  sendBinary(data: ArrayBuffer): void {
    this.peer?.emit({ type: 'message', data });
  }
  waitForBufferedAmountLow(): Promise<void> {
    this.waitCount += 1;
    this.bufferedAmount = 0;
    return Promise.resolve();
  }
  subscribe(listener: (event: DuplexDataChannelEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.state === 'open') listener({ type: 'open' });
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.state = 'closed';
    this.emit({ type: 'close' });
    if (this.peer && this.peer.state !== 'closed') {
      this.peer.state = 'closed';
      this.peer.emit({ type: 'close' });
    }
  }
  emit(event: DuplexDataChannelEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function connectedServices(): {
  sender: FileTransferService;
  receiver: FileTransferService;
  a: FakeChannel;
  b: FakeChannel;
} {
  const sender = new FileTransferService();
  const receiver = new FileTransferService();
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  sender.attachChannel(a);
  receiver.attachChannel(b);
  return { sender, receiver, a, b };
}

function required<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Expected ${description}.`);
  return value;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FileTransferService', () => {
  it('requires acceptance, sends binary chunks and verifies the completed Blob bytes', async () => {
    const { sender, receiver } = connectedServices();
    const generatedBlobs: Blob[] = [];
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) generatedBlobs.push(blob);
      return 'blob:duplex-test';
    });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const file = new File(['Duplex file bytes'], 'notes.txt', { type: 'text/plain' });
    sender.sendFiles([file]);
    const outgoing = required(sender.transfers()[0], 'outgoing transfer');
    expect(outgoing.state).toBe('waiting-for-acceptance');
    const offer = required(receiver.transfers()[0], 'incoming offer');
    expect(offer.state).toBe('offered');
    expect(offer.name).toBe('notes.txt');

    receiver.accept(offer.id);
    await flush();
    expect(sender.transfers()[0]?.state).toBe('completed');
    expect(receiver.transfers()[0]?.state).toBe('completed');
    const url = receiver.downloadUrl(offer.id);
    expect(url).toBeTruthy();
    expect(generatedBlobs[0]).toBeInstanceOf(Blob);
    expect(await generatedBlobs[0]?.text()).toBe('Duplex file bytes');
    receiver.dismiss(offer.id);
    expect(revokeUrl).toHaveBeenCalledWith('blob:duplex-test');
    receiver.destroy();
    sender.destroy();
    createUrl.mockRestore();
    revokeUrl.mockRestore();
  });

  it('declines without sending binary data and starts the next queued file', async () => {
    const { sender, receiver, a } = connectedServices();
    const first = new File(['one'], 'one.txt');
    const second = new File(['two'], 'two.txt');
    const sendBinary = vi.spyOn(a, 'sendBinary');
    sender.sendFiles([first, second]);
    const [offer, queued] = sender.transfers();
    expect(queued?.state).toBe('queued');
    receiver.decline(required(receiver.transfers()[0], 'incoming offer').id);
    await flush();
    expect(sender.transfers().find((transfer) => transfer.id === offer?.id)?.state).toBe(
      'rejected',
    );
    expect(sender.transfers().find((transfer) => transfer.name === 'two.txt')?.state).toBe(
      'waiting-for-acceptance',
    );
    expect(sendBinary).not.toHaveBeenCalled();
    sender.destroy();
    receiver.destroy();
  });

  it('applies backpressure and reports transfer progress', async () => {
    const { sender, receiver, a } = connectedServices();
    a.bufferedAmount = 1024 * 1024 + 1;
    const file = new File([new Uint8Array(40 * 1024)], 'large-ish.bin');
    sender.sendFiles([file]);
    receiver.accept(required(receiver.transfers()[0], 'incoming offer').id);
    await flush();
    expect(a.waitCount).toBeGreaterThan(0);
    expect(sender.transfers()[0]?.bytes).toBe(file.size);
    expect(receiver.transfers()[0]?.bytes).toBe(file.size);
    sender.destroy();
    receiver.destroy();
  });

  it('rejects oversized files before offering and sanitizes remote path-like names', () => {
    const { sender, receiver, b } = connectedServices();
    const oversized = {
      name: 'huge.bin',
      size: 256 * 1024 * 1024 + 1,
      type: '',
      slice: vi.fn(),
    } as unknown as File;
    sender.sendFiles([oversized]);
    expect(sender.transfers()[0]?.state).toBe('failed');
    expect(sender.transfers()[0]?.error).toContain('256 MiB');

    b.emit({
      type: 'message',
      data: JSON.stringify({
        type: 'file-offer',
        transferId: crypto.randomUUID(),
        protocolVersion: 1,
        name: 'C:\\Users\\alice\\..\\private.txt',
        size: 4,
        mimeType: 'text/plain',
      }),
    });
    expect(receiver.transfers()[0]?.name).toBe('private.txt');
    sender.destroy();
    receiver.destroy();
  });

  it('supports sender and receiver cancellation, disconnect cleanup and object URL revocation', async () => {
    const { sender, receiver, a, b } = connectedServices();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const file = new File(['contents'], 'cancel.txt');
    sender.sendFiles([file]);
    const id = required(sender.transfers()[0], 'outgoing transfer').id;
    receiver.accept(required(receiver.transfers()[0], 'incoming offer').id);
    sender.cancel(id);
    expect(sender.transfers()[0]?.state).toBe('cancelled');
    await flush();

    const next = new File(['again'], 'again.txt');
    sender.sendFiles([next]);
    const incomingNext = required(
      receiver.transfers().find((transfer) => transfer.name === 'again.txt'),
      'second incoming offer',
    );
    receiver.cancel(incomingNext.id);
    expect(receiver.transfers().find((transfer) => transfer.id === incomingNext.id)?.state).toBe(
      'cancelled',
    );
    await flush();
    sender.sendFiles([new File(['waiting'], 'waiting.txt')]);
    a.close();
    expect(sender.transfers().some((transfer) => transfer.state === 'failed')).toBe(true);
    sender.destroy();
    receiver.destroy();
    revoke.mockRestore();
    expect(b.state).toBe('closed');
  });

  it('closes a channel on malformed control data and releases resources on destroy', () => {
    const { sender, receiver, b } = connectedServices();
    b.emit({ type: 'message', data: '{' });
    expect(b.state).toBe('closed');
    sender.destroy();
    receiver.destroy();
  });

  it('fails a partial incoming transfer on disconnect and releases it on peer replacement', () => {
    const { sender, receiver, a, b } = connectedServices();
    const id = crypto.randomUUID();
    a.sendText(
      JSON.stringify({
        type: 'file-offer',
        transferId: id,
        protocolVersion: 1,
        name: 'partial.bin',
        size: 4,
        mimeType: 'application/octet-stream',
      }),
    );
    receiver.accept(id);
    b.emit({ type: 'message', data: new Uint8Array([1, 2]).buffer });
    expect(receiver.transfers()[0]?.bytes).toBe(2);
    a.close();
    expect(receiver.transfers()[0]?.state).toBe('failed');
    expect(receiver.downloadUrl(id)).toBeNull();
    receiver.peerChanged();
    expect(receiver.transfers()[0]?.state).toBe('failed');
    sender.destroy();
    receiver.destroy();
  });
});
