import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { createRoomId } from '@duplex/protocol';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';
import RoomPage from './r.[roomId].page';

interface TestPeerEvent {
  type: string;
  state?: string;
  media?: { audio: MediaStream | null; camera: null; screen: null };
  channel?: DuplexDataChannel;
  label?: string;
}

const peerHarness = vi.hoisted(() => ({
  listeners: [] as ((event: TestPeerEvent) => void)[],
  closed: false,
}));

vi.mock('@duplex/webrtc', () => ({
  DATA_CHANNEL_LABELS: {
    fileTransfer: 'duplex-file-transfer',
    collaboration: 'duplex-collaboration',
    pointer: 'duplex-pointer',
    control: 'duplex-control',
    input: 'duplex-input',
  },
  toRtcIceServers: (
    iceServers: { urls: string | string[]; username?: string; credential?: string }[],
  ) => iceServers.map((server) => ({ ...server })),
  createDuplexPeer: vi.fn(() => ({
    connectionState: 'connecting',
    subscribe: (listener: (event: TestPeerEvent) => void) => {
      peerHarness.listeners.push(listener);
      return () => {
        peerHarness.listeners = peerHarness.listeners.filter((candidate) => candidate !== listener);
      };
    },
    close: () => {
      peerHarness.closed = true;
    },
  })),
}));

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static latest: FakeWebSocket | null = null;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    });
  }

  send(message: string): void {
    this.sent.push(message);
  }

  receive(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

class FakeFileDataChannel implements DuplexDataChannel {
  readonly label = 'duplex-file-transfer' as const;
  state: DuplexDataChannel['state'] = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 256 * 1024;
  readonly sentText: string[] = [];
  readonly sentBinary: ArrayBuffer[] = [];
  private listeners = new Set<(event: DuplexDataChannelEvent) => void>();

  sendText(data: string): void {
    this.sentText.push(data);
  }
  sendBinary(data: ArrayBuffer): void {
    this.sentBinary.push(data);
  }
  waitForBufferedAmountLow(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(listener: (event: DuplexDataChannelEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'open' });
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.state = 'closed';
    this.receive({ type: 'close' });
  }
  receive(event: DuplexDataChannelEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  receiveControl(message: object): void {
    this.receive({ type: 'message', data: JSON.stringify(message) });
  }
}

function controlTypes(channel: FakeFileDataChannel): string[] {
  return channel.sentText.map((text) => {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('type' in parsed) ||
      typeof parsed.type !== 'string'
    )
      throw new Error('Unexpected control message.');
    return parsed.type;
  });
}

async function render(
  roomId: string,
): Promise<{ element: HTMLElement; fixture: ComponentFixture<RoomPage> }> {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(RoomPage);
  fixture.componentRef.setInput('roomId', roomId);
  await fixture.whenStable();
  return { element: fixture.nativeElement as HTMLElement, fixture };
}

describe('RoomPage', () => {
  let track: { enabled: boolean; stop: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    peerHarness.listeners = [];
    peerHarness.closed = false;
    FakeWebSocket.latest = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    track = { enabled: true, stop: vi.fn() };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
  });

  it('shows a ready-to-join state for a valid room', async () => {
    const { element } = await render(createRoomId());
    expect(element.querySelector('h1')?.textContent).toContain('Ready to join');
    expect(element.querySelector('button')?.textContent).toContain('Join call');
  });

  it('rejects ids that are not Duplex room ids', async () => {
    const { element } = await render('1');
    expect(element.querySelector('h1')?.textContent).toContain('Invalid room link');
  });

  it('shows a clear error when microphone access fails', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const { element, fixture } = await render(createRoomId());
    const button = element.querySelector('button');
    button?.click();
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Microphone permission');
    expect(element.querySelector('h1')?.textContent).toContain('Could not join');
  });

  it('moves through joining, waiting, peer arrival, connected, mute, and leave cleanup', async () => {
    const { element, fixture } = await render(createRoomId());
    element.querySelector('button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(element.querySelector('h1')?.textContent).toContain('Joining');

    const socket = FakeWebSocket.latest;
    expect(socket?.sent[0]).toContain('"type":"join"');
    socket?.receive({
      type: 'joined',
      payload: { participantId: 'abcdefghijklmnop', polite: false, peerPresent: false },
    });
    socket?.receive({
      type: 'rtc-config',
      payload: {
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        expiresAt: Date.now() + 60_000,
        relayAvailable: false,
      },
    });
    fixture.detectChanges();
    expect(element.querySelector('h1')?.textContent).toContain('Waiting for someone');

    socket?.receive({ type: 'peer-joined', payload: { participantId: 'qrstuvwxyzabcdef' } });
    peerHarness.listeners[0]?.({ type: 'connection-state', state: 'connected' });
    fixture.detectChanges();
    expect(element.querySelector('h1')?.textContent).toContain('Connected');
    const buttons = [...element.querySelectorAll('button')];
    buttons.find((button) => button.textContent.trim() === 'Mute')?.click();
    expect(track.enabled).toBe(false);

    [...element.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Leave')
      ?.click();
    fixture.detectChanges();
    expect(element.querySelector('h1')?.textContent).toContain('You left the call');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peerHarness.closed).toBe(true);
    expect(socket?.closed).toBe(true);
  });

  it('returns to waiting when the peer leaves and shows a clean full-room error', async () => {
    const { element, fixture } = await render(createRoomId());
    element.querySelector('button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = FakeWebSocket.latest;
    socket?.receive({
      type: 'joined',
      payload: { participantId: 'abcdefghijklmnop', polite: false, peerPresent: true },
    });
    socket?.receive({
      type: 'rtc-config',
      payload: {
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        expiresAt: Date.now() + 60_000,
        relayAvailable: false,
      },
    });
    peerHarness.listeners[0]?.({ type: 'connection-state', state: 'connected' });
    socket?.receive({ type: 'peer-left', payload: {} });
    fixture.detectChanges();
    expect(element.querySelector('h1')?.textContent).toContain('Waiting for someone');

    socket?.receive({ type: 'room-full', payload: { reason: 'capacity' } });
    fixture.detectChanges();
    expect(element.querySelector('h1')?.textContent).toContain('Could not join');
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'already has two participants',
    );
  });

  it('shows file controls, consent, progress, cancellation and a completed download', async () => {
    const { element, fixture } = await render(createRoomId());
    element.querySelector('button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = FakeWebSocket.latest;
    socket?.receive({
      type: 'joined',
      payload: { participantId: 'abcdefghijklmnop', polite: false, peerPresent: true },
    });
    socket?.receive({
      type: 'rtc-config',
      payload: {
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        expiresAt: Date.now() + 60_000,
        relayAvailable: false,
      },
    });
    const channel = new FakeFileDataChannel();
    peerHarness.listeners[0]?.({ type: 'connection-state', state: 'connected' });
    peerHarness.listeners[0]?.({ type: 'data-channel', channel });
    fixture.detectChanges();
    expect(
      [...element.querySelectorAll('button')].some((button) =>
        button.textContent.includes('Send file'),
      ),
    ).toBe(true);

    const cancelledId = crypto.randomUUID();
    channel.receiveControl({
      type: 'file-offer',
      transferId: cancelledId,
      protocolVersion: 1,
      name: 'cancel.bin',
      size: 4,
      mimeType: 'application/octet-stream',
    });
    fixture.detectChanges();
    expect(element.textContent).toContain('Peer wants to send');
    [...element.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Accept')
      ?.click();
    expect(controlTypes(channel)).toContain('file-accept');
    fixture.detectChanges();
    expect(
      [...element.querySelectorAll('button')].some((button) =>
        button.textContent.includes('Send file'),
      ),
    ).toBe(true);
    channel.receive({ type: 'message', data: new Uint8Array([1, 2]).buffer });
    fixture.detectChanges();
    expect(element.textContent).toContain('50%');
    [...element.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Cancel')
      ?.click();
    expect(controlTypes(channel)).toContain('file-cancel');

    const declinedId = crypto.randomUUID();
    channel.receiveControl({
      type: 'file-offer',
      transferId: declinedId,
      protocolVersion: 1,
      name: 'declined.txt',
      size: 1,
      mimeType: 'text/plain',
    });
    fixture.detectChanges();
    [...element.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Decline')
      ?.click();
    expect(controlTypes(channel)).toContain('file-reject');

    const completedId = crypto.randomUUID();
    channel.receiveControl({
      type: 'file-offer',
      transferId: completedId,
      protocolVersion: 1,
      name: 'received.txt',
      size: 2,
      mimeType: 'text/plain',
    });
    fixture.detectChanges();
    [...element.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Accept')
      ?.click();
    channel.receive({ type: 'message', data: new Uint8Array([65, 66]).buffer });
    channel.receiveControl({ type: 'file-complete', transferId: completedId, protocolVersion: 1 });
    fixture.detectChanges();
    expect(element.querySelector('a[download="received.txt"]')?.textContent).toContain('Download');
    expect(controlTypes(channel)).toContain('file-complete');
    channel.receive({ type: 'message', data: '{' });
    fixture.detectChanges();
    expect(element.querySelector('h1')?.textContent).toContain('Connected');
  });
});
