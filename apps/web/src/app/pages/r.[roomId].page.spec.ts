import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { createRoomId } from '@duplex/protocol';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';
import { render as renderComponent, screen, within } from '@testing-library/angular';
import { userEvent } from '@testing-library/user-event';
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

const RTC_CONFIG = {
  type: 'rtc-config',
  payload: {
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    expiresAt: Date.now() + 60_000,
    relayAvailable: false,
  },
};

async function renderRoom(roomId: string) {
  return renderComponent(RoomPage, {
    inputs: { roomId },
    providers: [provideRouter([])],
  });
}

/** Joins as the impolite peer and waits until the fake socket has seen the join message. */
async function joinRoom(peerPresent: boolean): Promise<FakeWebSocket> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Join call' }));
  await vi.waitFor(() => {
    expect(FakeWebSocket.latest?.sent[0]).toContain('"type":"join"');
  });
  const socket = FakeWebSocket.latest;
  if (!socket) throw new Error('The room WebSocket was not opened.');
  socket.receive({
    type: 'joined',
    payload: { participantId: 'abcdefghijklmnop', polite: false, peerPresent },
  });
  socket.receive(RTC_CONFIG);
  return socket;
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
    await renderRoom(createRoomId());

    expect(screen.getByRole('heading', { name: 'Ready to join' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Join call' })).toBeEnabled();
    expect(screen.queryByRole('group', { name: 'Call controls' })).not.toBeInTheDocument();
  });

  it('rejects ids that are not Duplex room ids', async () => {
    await renderRoom('1');

    expect(screen.getByRole('heading', { name: 'Invalid room link' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Start a new call' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Join call' })).not.toBeInTheDocument();
  });

  it('shows a clear error when microphone access fails', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const user = userEvent.setup();
    await renderRoom(createRoomId());

    await user.click(screen.getByRole('button', { name: 'Join call' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone permission');
    expect(screen.getByRole('heading', { name: 'Could not join the call' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('moves through joining, waiting, peer arrival, connected, mute, and leave cleanup', async () => {
    const user = userEvent.setup();
    await renderRoom(createRoomId());

    const socket = await joinRoom(false);

    expect(
      await screen.findByRole('heading', { name: 'Waiting for someone to join…' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Copy this link')).toHaveAttribute('readonly');

    socket.receive({ type: 'peer-joined', payload: { participantId: 'qrstuvwxyzabcdef' } });
    peerHarness.listeners[0]?.({ type: 'connection-state', state: 'connected' });
    expect(await screen.findByRole('heading', { name: 'Connected' })).toBeVisible();
    expect(screen.queryByLabelText('Copy this link')).not.toBeInTheDocument();

    const mute = screen.getByRole('button', { name: 'Mute' });
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    await user.click(mute);
    expect(track.enabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(await screen.findByRole('heading', { name: 'You left the call' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rejoin call' })).toBeVisible();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peerHarness.closed).toBe(true);
    expect(socket.closed).toBe(true);
  });

  it('copies the invite link and confirms it', async () => {
    vi.stubGlobal('isSecureContext', true);
    // user-event installs its own clipboard stub, so read back what the page wrote to it.
    const user = userEvent.setup();
    await renderRoom(createRoomId());
    await joinRoom(false);

    await user.click(await screen.findByRole('button', { name: 'Copy link' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await navigator.clipboard.readText()).toBe(
      screen.getByLabelText<HTMLInputElement>('Copy this link').value,
    );
  });

  it('returns to waiting when the peer leaves and shows a clean full-room error', async () => {
    await renderRoom(createRoomId());
    const socket = await joinRoom(true);
    peerHarness.listeners[0]?.({ type: 'connection-state', state: 'connected' });

    socket.receive({ type: 'peer-left', payload: {} });
    expect(
      await screen.findByRole('heading', { name: 'Waiting for someone to join…' }),
    ).toBeVisible();

    socket.receive({ type: 'room-full', payload: { reason: 'capacity' } });
    expect(await screen.findByRole('heading', { name: 'Could not join the call' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('already has two participants');
  });

  it('shows file controls, consent, progress, cancellation and a completed download', async () => {
    const user = userEvent.setup();
    await renderRoom(createRoomId());
    await joinRoom(true);
    const channel = new FakeFileDataChannel();
    peerHarness.listeners[0]?.({ type: 'connection-state', state: 'connected' });
    peerHarness.listeners[0]?.({ type: 'data-channel', channel });
    expect(await screen.findByRole('button', { name: 'Send file' })).toBeVisible();

    const offer = (transferId: string, name: string, size: number, mimeType: string) => {
      channel.receiveControl({
        type: 'file-offer',
        transferId,
        protocolVersion: 1,
        name,
        size,
        mimeType,
      });
    };

    offer(crypto.randomUUID(), 'cancel.bin', 4, 'application/octet-stream');
    expect(await screen.findByText('Peer wants to send')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(controlTypes(channel)).toContain('file-accept');
    channel.receive({ type: 'message', data: new Uint8Array([1, 2]).buffer });
    const progress = await screen.findByRole('progressbar', {
      name: 'Transfer progress for cancel.bin',
    });
    expect(progress).toHaveAttribute('value', '2');
    expect(screen.getByText('50%')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(controlTypes(channel)).toContain('file-cancel');

    offer(crypto.randomUUID(), 'declined.txt', 1, 'text/plain');
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(controlTypes(channel)).toContain('file-reject');

    const completedId = crypto.randomUUID();
    offer(completedId, 'received.txt', 2, 'text/plain');
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    channel.receive({ type: 'message', data: new Uint8Array([65, 66]).buffer });
    channel.receiveControl({ type: 'file-complete', transferId: completedId, protocolVersion: 1 });
    const transfers = screen.getByRole('region', { name: 'File transfers' });
    expect(await within(transfers).findByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
      'received.txt',
    );
    expect(controlTypes(channel)).toContain('file-complete');

    channel.receive({ type: 'message', data: '{' });
    expect(await screen.findByRole('heading', { name: 'Connected' })).toBeVisible();
  });
});
