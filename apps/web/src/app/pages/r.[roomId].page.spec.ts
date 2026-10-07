import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { createRoomId } from '@duplex/protocol';
import RoomPage from './r.[roomId].page';

const peerHarness = vi.hoisted(() => ({
  listeners: [] as ((event: {
    type: string;
    state?: string;
    media?: { audio: MediaStream | null; camera: null; screen: null };
  }) => void)[],
  closed: false,
}));

vi.mock('@duplex/webrtc', () => ({
  createDuplexPeer: vi.fn(() => ({
    connectionState: 'connecting',
    subscribe: (
      listener: (event: {
        type: string;
        state?: string;
        media?: { audio: MediaStream | null; camera: null; screen: null };
      }) => void,
    ) => {
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
});
