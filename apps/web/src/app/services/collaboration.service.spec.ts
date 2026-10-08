import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_COLLABORATION_STROKES_PER_SURFACE } from '@duplex/protocol';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';
import { CollaborationService } from './collaboration.service';

class FakeChannel implements DuplexDataChannel {
  state: DuplexDataChannel['state'] = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: string[] = [];
  readonly sentBinary: ArrayBuffer[] = [];
  private readonly listeners = new Set<(event: DuplexDataChannelEvent) => void>();

  constructor(readonly label: DuplexDataChannel['label']) {}
  sendText(data: string): void {
    this.sent.push(data);
  }
  sendBinary(data: ArrayBuffer): void {
    this.sentBinary.push(data);
  }
  waitForBufferedAmountLow(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(listener: (event: DuplexDataChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.state = 'closed';
    this.emit({ type: 'close' });
  }
  open(): void {
    this.state = 'open';
    this.emit({ type: 'open' });
  }
  receive(message: unknown): void {
    this.emit({ type: 'message', data: JSON.stringify(message) });
  }
  private emit(event: DuplexDataChannelEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function sent(channel: FakeChannel): Record<string, unknown>[] {
  return channel.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
}

describe('CollaborationService', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the current media state when the channel opens late', () => {
    const service = new CollaborationService();
    const channel = new FakeChannel('duplex-collaboration');
    service.attachChannel(channel);
    service.setLocalVideoSource('screen');
    const surfaceId = service.localSurfaceId();
    expect(surfaceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(channel.sent).toHaveLength(0);
    channel.open();
    expect(sent(channel)).toEqual([
      { type: 'media-state', protocolVersion: 1, videoSource: 'screen', surfaceId },
    ]);
    expect(service.surfaceId()).toBe(surfaceId);
  });

  it('ignores old-surface annotations and resets when a replacement peer arrives', () => {
    const service = new CollaborationService();
    const channel = new FakeChannel('duplex-collaboration');
    const oldSurface = crypto.randomUUID();
    const nextSurface = crypto.randomUUID();
    service.attachChannel(channel);
    channel.open();
    channel.receive({
      type: 'media-state',
      protocolVersion: 1,
      videoSource: 'screen',
      surfaceId: oldSurface,
    });
    channel.receive({
      type: 'stroke-start',
      protocolVersion: 1,
      surfaceId: oldSurface,
      strokeId: crypto.randomUUID(),
      point: { x: 0.2, y: 0.3 },
    });
    expect(service.strokes()).toHaveLength(1);
    channel.receive({
      type: 'media-state',
      protocolVersion: 1,
      videoSource: 'screen',
      surfaceId: nextSurface,
    });
    expect(service.surfaceId()).toBe(nextSurface);
    expect(service.strokes()).toEqual([]);
    channel.receive({
      type: 'annotations-clear',
      protocolVersion: 1,
      surfaceId: oldSurface,
    });
    expect(service.strokes()).toEqual([]);
    service.peerChanged();
    expect(service.peerSurfaceId()).toBeNull();
    expect(service.remotePointer()).toBeNull();
  });

  it('reconstructs remote strokes, applies hide messages, and caps peer-provided strokes', () => {
    const service = new CollaborationService();
    const collaboration = new FakeChannel('duplex-collaboration');
    const pointer = new FakeChannel('duplex-pointer');
    const surfaceId = crypto.randomUUID();
    collaboration.open();
    pointer.open();
    service.attachChannel(collaboration);
    service.attachChannel(pointer);
    collaboration.receive({
      type: 'media-state',
      protocolVersion: 1,
      videoSource: 'screen',
      surfaceId,
    });
    const strokeId = crypto.randomUUID();
    collaboration.receive({
      type: 'stroke-start',
      protocolVersion: 1,
      surfaceId,
      strokeId,
      point: { x: 0.1, y: 0.2 },
    });
    collaboration.receive({
      type: 'stroke-points',
      protocolVersion: 1,
      surfaceId,
      strokeId,
      points: [
        { x: 0.3, y: 0.4 },
        { x: 0.5, y: 0.6 },
      ],
    });
    collaboration.receive({
      type: 'stroke-end',
      protocolVersion: 1,
      surfaceId,
      strokeId,
    });
    expect(service.strokes()[0]?.points).toEqual([
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 },
      { x: 0.5, y: 0.6 },
    ]);
    for (let index = 1; index < MAX_COLLABORATION_STROKES_PER_SURFACE + 1; index++)
      collaboration.receive({
        type: 'stroke-start',
        protocolVersion: 1,
        surfaceId,
        strokeId: crypto.randomUUID(),
        point: { x: 0.5, y: 0.5 },
      });
    expect(service.strokes()).toHaveLength(MAX_COLLABORATION_STROKES_PER_SURFACE);
    pointer.receive({
      type: 'pointer',
      protocolVersion: 1,
      surfaceId,
      mode: 'pointer',
      x: 0.5,
      y: 0.5,
      sequence: 1,
    });
    pointer.receive({
      type: 'pointer-hide',
      protocolVersion: 1,
      surfaceId,
      sequence: 2,
    });
    expect(service.remotePointer()).toBeNull();
  });

  it('rejects out-of-order pointer packets and expires stale pointers and lasers', () => {
    vi.useFakeTimers();
    const service = new CollaborationService();
    const collaboration = new FakeChannel('duplex-collaboration');
    const pointer = new FakeChannel('duplex-pointer');
    const surfaceId = crypto.randomUUID();
    service.attachChannel(collaboration);
    service.attachChannel(pointer);
    collaboration.open();
    pointer.open();
    collaboration.receive({
      type: 'media-state',
      protocolVersion: 1,
      videoSource: 'screen',
      surfaceId,
    });
    pointer.receive({
      type: 'pointer',
      protocolVersion: 1,
      surfaceId,
      mode: 'pointer',
      x: 0.2,
      y: 0.3,
      sequence: 2,
    });
    expect(service.remotePointer()).toEqual({ mode: 'pointer', x: 0.2, y: 0.3 });
    pointer.receive({
      type: 'pointer',
      protocolVersion: 1,
      surfaceId,
      mode: 'pointer',
      x: 0.8,
      y: 0.9,
      sequence: 1,
    });
    expect(service.remotePointer()?.x).toBe(0.2);
    vi.advanceTimersByTime(1800);
    expect(service.remotePointer()).toBeNull();
    pointer.receive({
      type: 'pointer',
      protocolVersion: 1,
      surfaceId,
      mode: 'laser',
      x: 0.5,
      y: 0.5,
      sequence: 3,
    });
    vi.advanceTimersByTime(650);
    expect(service.remotePointer()).toBeNull();
  });

  it('renders local strokes immediately, batches points, and synchronizes clear', () => {
    vi.useFakeTimers();
    const service = new CollaborationService();
    const channel = new FakeChannel('duplex-collaboration');
    service.attachChannel(channel);
    channel.open();
    service.setLocalVideoSource('screen');
    const surfaceId = service.localSurfaceId();
    const point = { x: 0.25, y: 0.5 };
    service.beginStroke(point);
    expect(service.strokes()).toHaveLength(1);
    expect(service.strokes()[0]?.points).toEqual([point]);
    service.addStrokePoint({ x: 0.3, y: 0.55 });
    vi.advanceTimersByTime(32);
    service.finishStroke();
    expect(sent(channel).map((message) => message['type'])).toEqual([
      'media-state',
      'media-state',
      'stroke-start',
      'stroke-points',
      'stroke-end',
    ]);
    expect(sent(channel)[1]?.['surfaceId']).toBe(surfaceId);
    service.clearAnnotations();
    expect(service.strokes()).toEqual([]);
    expect(sent(channel).at(-1)?.['type']).toBe('annotations-clear');
    service.setLocalVideoSource('none');
    expect(service.surfaceId()).toBeNull();
    expect(service.strokes()).toEqual([]);
  });

  it('detaches channels independently and treats channel failures as domain-local', () => {
    const service = new CollaborationService();
    const collaboration = new FakeChannel('duplex-collaboration');
    const pointer = new FakeChannel('duplex-pointer');
    service.attachChannel(collaboration);
    service.attachChannel(pointer);
    collaboration.open();
    pointer.open();
    expect(service.collaborationChannelOpen()).toBe(true);
    expect(service.pointerChannelOpen()).toBe(true);
    collaboration.close();
    expect(service.collaborationChannelOpen()).toBe(false);
    expect(service.pointerChannelOpen()).toBe(true);
    pointer.close();
    expect(service.pointerChannelOpen()).toBe(false);
  });
});
