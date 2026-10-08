import { computed, signal } from '@angular/core';
import {
  COLLABORATION_PROTOCOL_VERSION,
  MAX_COLLABORATION_BATCH_POINTS,
  MAX_COLLABORATION_POINTS_PER_STROKE,
  MAX_COLLABORATION_POINTS_PER_SURFACE,
  MAX_COLLABORATION_STROKES_PER_SURFACE,
  collaborationMessageSchema,
  pointerMessageSchema,
} from '@duplex/protocol';
import type { CollaborationMessage, PointerMessage } from '@duplex/protocol';
import { DATA_CHANNEL_LABELS } from '@duplex/webrtc';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';

export type CollaborationTool = 'off' | 'pointer' | 'laser' | 'draw';
export type VideoSource = 'none' | 'camera' | 'screen';
export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}
export interface CollaborationStroke {
  readonly id: string;
  readonly points: readonly NormalizedPoint[];
}
export interface RemotePointer {
  readonly mode: 'pointer' | 'laser';
  readonly x: number;
  readonly y: number;
}

const POINTER_INACTIVITY_MS = 1800;
const LASER_INACTIVITY_MS = 650;
const STROKE_FLUSH_MS = 32;

export class CollaborationService {
  readonly tool = signal<CollaborationTool>('off');
  readonly collaborationChannelOpen = signal(false);
  readonly pointerChannelOpen = signal(false);
  readonly surfaceRevision = signal(0);
  readonly localVideoSource = signal<VideoSource>('none');
  readonly localSurfaceId = signal<string | null>(null);
  readonly peerVideoSource = signal<VideoSource>('none');
  readonly peerSurfaceId = signal<string | null>(null);
  readonly surfaceId = computed(() =>
    this.peerVideoSource() === 'screen' ? this.peerSurfaceId() : this.localSurfaceId(),
  );
  readonly surfaceActive = computed(() => this.surfaceId() !== null);
  readonly remotePointer = signal<RemotePointer | null>(null);
  readonly strokes = signal<readonly CollaborationStroke[]>([]);

  private collaborationChannel: DuplexDataChannel | null = null;
  private pointerChannel: DuplexDataChannel | null = null;
  private collaborationUnsubscribe: (() => void) | null = null;
  private pointerUnsubscribe: (() => void) | null = null;
  private channelEventUnsubscribers = new Map<DuplexDataChannel, () => void>();
  private pointerSequence = 0;
  private lastPeerSequence = -1;
  private pointerTimer: ReturnType<typeof setTimeout> | null = null;
  private strokeFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStroke: { id: string; points: NormalizedPoint[] } | null = null;
  private totalPoints = 0;

  attachChannel(channel: DuplexDataChannel): void {
    if (channel.label === DATA_CHANNEL_LABELS.collaboration) {
      if (this.collaborationChannel === channel) return;
      this.detachCollaborationChannel();
      this.collaborationChannel = channel;
      const onEvent = (event: DuplexDataChannelEvent): void => {
        switch (event.type) {
          case 'message':
            this.receiveCollaboration(event.data);
            break;
          case 'close':
            this.detachCollaborationChannel();
            break;
          case 'open':
            this.collaborationChannelOpen.set(true);
            this.sendMediaState();
            break;
        }
      };
      this.collaborationUnsubscribe = channel.subscribe(onEvent);
      this.collaborationChannelOpen.set(channel.state === 'open');
      this.channelEventUnsubscribers.set(channel, this.collaborationUnsubscribe);
      if (channel.state === 'open') this.sendMediaState();
      return;
    }
    if (channel.label === DATA_CHANNEL_LABELS.pointer) {
      if (this.pointerChannel === channel) return;
      this.detachPointerChannel();
      this.pointerChannel = channel;
      const onEvent = (event: DuplexDataChannelEvent): void => {
        switch (event.type) {
          case 'message':
            this.receivePointer(event.data);
            break;
          case 'open':
            this.pointerChannelOpen.set(true);
            break;
          case 'close':
            this.detachPointerChannel();
            break;
        }
      };
      this.pointerUnsubscribe = channel.subscribe(onEvent);
      this.pointerChannelOpen.set(channel.state === 'open');
      this.channelEventUnsubscribers.set(channel, this.pointerUnsubscribe);
    }
  }

  setLocalVideoSource(source: VideoSource): void {
    const previousSurfaceId = this.localSurfaceId();
    const nextSurfaceId = source === 'screen' ? crypto.randomUUID() : null;
    this.localVideoSource.set(source);
    this.localSurfaceId.set(nextSurfaceId);
    if (source === 'screen') this.resetSurfaceState();
    this.sendMediaState();
    if (previousSurfaceId && source !== 'screen') this.resetSurfaceState();
  }

  setTool(tool: CollaborationTool): void {
    this.tool.set(tool);
    if (tool === 'off') this.sendPointerHide();
  }

  sendPointer(mode: 'pointer' | 'laser', point: NormalizedPoint): void {
    const surfaceId = this.surfaceId();
    if (!surfaceId || this.pointerChannel?.state !== 'open') return;
    const message: PointerMessage = {
      type: 'pointer',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      surfaceId,
      mode,
      ...point,
      sequence: ++this.pointerSequence,
    };
    this.send(this.pointerChannel, message);
  }

  sendPointerHide(): void {
    const surfaceId = this.surfaceId();
    if (!surfaceId || this.pointerChannel?.state !== 'open') return;
    const message: PointerMessage = {
      type: 'pointer-hide',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      surfaceId,
      sequence: ++this.pointerSequence,
    };
    this.send(this.pointerChannel, message);
  }

  beginStroke(point: NormalizedPoint): void {
    const surfaceId = this.surfaceId();
    if (!surfaceId || this.collaborationChannel?.state !== 'open') return;
    this.finishStroke();
    if (this.strokes().length >= MAX_COLLABORATION_STROKES_PER_SURFACE) return;
    const id = crypto.randomUUID();
    const stroke = { id, points: [point] };
    this.strokes.update((strokes) => [...strokes, stroke]);
    this.totalPoints += 1;
    this.pendingStroke = { id, points: [] };
    this.send(this.collaborationChannel, {
      type: 'stroke-start',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      surfaceId,
      strokeId: id,
      point,
    });
  }

  addStrokePoint(point: NormalizedPoint): void {
    const pending = this.pendingStroke;
    if (!pending || this.totalPoints >= MAX_COLLABORATION_POINTS_PER_SURFACE) return;
    const strokeIndex = this.strokes().findIndex((stroke) => stroke.id === pending.id);
    if (strokeIndex < 0) return;
    const stroke = this.strokes()[strokeIndex];
    if (!stroke || stroke.points.length >= MAX_COLLABORATION_POINTS_PER_STROKE) return;
    this.strokes.update((strokes) =>
      strokes.map((item) =>
        item.id === pending.id ? { ...item, points: [...item.points, point] } : item,
      ),
    );
    this.totalPoints += 1;
    pending.points.push(point);
    if (pending.points.length >= MAX_COLLABORATION_BATCH_POINTS) this.flushStrokePoints();
    else
      this.strokeFlushTimer ??= setTimeout(() => {
        this.flushStrokePoints();
      }, STROKE_FLUSH_MS);
  }

  finishStroke(): void {
    const pending = this.pendingStroke;
    if (!pending) return;
    this.flushStrokePoints();
    const surfaceId = this.surfaceId();
    if (surfaceId && this.collaborationChannel?.state === 'open')
      this.send(this.collaborationChannel, {
        type: 'stroke-end',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        surfaceId,
        strokeId: pending.id,
      });
    this.pendingStroke = null;
  }

  clearAnnotations(): void {
    const surfaceId = this.surfaceId();
    this.strokes.set([]);
    this.totalPoints = 0;
    this.pendingStroke = null;
    this.clearStrokeTimer();
    if (surfaceId && this.collaborationChannel?.state === 'open')
      this.send(this.collaborationChannel, {
        type: 'annotations-clear',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        surfaceId,
      });
  }

  peerChanged(): void {
    this.detachCollaborationChannel();
    this.detachPointerChannel();
    this.peerVideoSource.set('none');
    this.peerSurfaceId.set(null);
    this.resetSurfaceState();
    this.lastPeerSequence = -1;
  }

  destroy(): void {
    this.peerChanged();
    this.localVideoSource.set('none');
    this.localSurfaceId.set(null);
  }

  private receiveCollaboration(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = collaborationMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'media-state') {
      const changed = this.peerSurfaceId() !== message.surfaceId;
      this.peerVideoSource.set(message.videoSource);
      this.peerSurfaceId.set(message.surfaceId);
      if (changed) this.resetSurfaceState();
      return;
    }
    if (message.surfaceId !== this.surfaceId()) return;
    if (message.type === 'stroke-start') {
      if (
        this.strokes().length >= MAX_COLLABORATION_STROKES_PER_SURFACE ||
        this.totalPoints >= MAX_COLLABORATION_POINTS_PER_SURFACE ||
        this.strokes().some((stroke) => stroke.id === message.strokeId)
      )
        return;
      this.strokes.update((strokes) => [
        ...strokes,
        { id: message.strokeId, points: [message.point] },
      ]);
      this.totalPoints += 1;
    } else if (message.type === 'stroke-points') {
      const index = this.strokes().findIndex((stroke) => stroke.id === message.strokeId);
      const stroke = this.strokes()[index];
      if (
        !stroke ||
        stroke.points.length + message.points.length > MAX_COLLABORATION_POINTS_PER_STROKE ||
        this.totalPoints + message.points.length > MAX_COLLABORATION_POINTS_PER_SURFACE
      )
        return;
      this.strokes.update((strokes) =>
        strokes.map((item, itemIndex) =>
          itemIndex === index ? { ...item, points: [...item.points, ...message.points] } : item,
        ),
      );
      this.totalPoints += message.points.length;
    } else if (message.type === 'stroke-end') {
      if (this.pendingStroke?.id === message.strokeId) this.pendingStroke = null;
    } else {
      this.strokes.set([]);
      this.totalPoints = 0;
      this.pendingStroke = null;
      this.clearStrokeTimer();
    }
  }

  private receivePointer(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = pointerMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.surfaceId !== this.surfaceId() || message.sequence <= this.lastPeerSequence) return;
    this.lastPeerSequence = message.sequence;
    if (message.type === 'pointer-hide') this.remotePointer.set(null);
    else this.remotePointer.set({ mode: message.mode, x: message.x, y: message.y });
    this.clearPointerTimer();
    if (message.type === 'pointer')
      this.pointerTimer = setTimeout(
        () => {
          this.remotePointer.set(null);
        },
        message.mode === 'laser' ? LASER_INACTIVITY_MS : POINTER_INACTIVITY_MS,
      );
  }

  private sendMediaState(): void {
    if (this.collaborationChannel?.state !== 'open') return;
    this.send(this.collaborationChannel, {
      type: 'media-state',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      videoSource: this.localVideoSource(),
      surfaceId: this.localSurfaceId(),
    });
  }

  private send(channel: DuplexDataChannel, message: CollaborationMessage | PointerMessage): void {
    try {
      channel.sendText(JSON.stringify(message));
    } catch {
      // Collaboration transport failures must not affect the call or file transfer.
    }
  }

  private flushStrokePoints(): void {
    this.clearStrokeTimer();
    const pending = this.pendingStroke;
    const surfaceId = this.surfaceId();
    const channel = this.collaborationChannel;
    if (!pending?.points.length || !surfaceId || channel?.state !== 'open') return;
    const points = pending.points.splice(0, MAX_COLLABORATION_BATCH_POINTS);
    this.send(channel, {
      type: 'stroke-points',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      surfaceId,
      strokeId: pending.id,
      points,
    });
    if (pending.points.length) this.flushStrokePoints();
  }

  private resetSurfaceState(): void {
    this.surfaceRevision.update((revision) => revision + 1);
    this.tool.set('off');
    this.remotePointer.set(null);
    this.strokes.set([]);
    this.pendingStroke = null;
    this.totalPoints = 0;
    this.pointerSequence = 0;
    this.lastPeerSequence = -1;
    this.clearPointerTimer();
    this.clearStrokeTimer();
  }

  private clearPointerTimer(): void {
    if (this.pointerTimer) clearTimeout(this.pointerTimer);
    this.pointerTimer = null;
  }

  private clearStrokeTimer(): void {
    if (this.strokeFlushTimer) clearTimeout(this.strokeFlushTimer);
    this.strokeFlushTimer = null;
  }

  private detachCollaborationChannel(): void {
    if (this.collaborationChannel) {
      const unsubscribe = this.channelEventUnsubscribers.get(this.collaborationChannel);
      unsubscribe?.();
      this.channelEventUnsubscribers.delete(this.collaborationChannel);
    }
    this.collaborationChannel = null;
    this.collaborationUnsubscribe = null;
    this.collaborationChannelOpen.set(false);
    this.resetSurfaceState();
  }

  private detachPointerChannel(): void {
    if (this.pointerChannel) {
      const unsubscribe = this.channelEventUnsubscribers.get(this.pointerChannel);
      unsubscribe?.();
      this.channelEventUnsubscribers.delete(this.pointerChannel);
    }
    this.pointerChannel = null;
    this.pointerUnsubscribe = null;
    this.pointerChannelOpen.set(false);
    if (this.tool() === 'pointer' || this.tool() === 'laser') this.tool.set('off');
    this.remotePointer.set(null);
    this.clearPointerTimer();
  }
}
