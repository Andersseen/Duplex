import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const peerHarness = vi.hoisted(() => ({
  created: [] as { tracks: (MediaStreamTrack | null)[]; close: ReturnType<typeof vi.fn> }[],
}));

vi.mock('@duplex/webrtc', () => ({
  createDuplexPeer: vi.fn(() => {
    const listeners: ((event: unknown) => void)[] = [];
    const peer = {
      tracks: [] as (MediaStreamTrack | null)[],
      close: vi.fn(),
      connectionState: 'connecting',
      setVideoTrack: vi.fn((track: MediaStreamTrack | null) => {
        peer.tracks.push(track);
        return Promise.resolve();
      }),
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    peerHarness.created.push(peer);
    return peer;
  }),
}));

import { CallSessionService } from './call-session.service';
import { createRoomId } from '@duplex/protocol';

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

function mediaTrack(kind: 'audio' | 'video') {
  const track = {
    kind,
    enabled: true,
    onended: null as (() => void) | null,
    stopCount: { value: 0 },
    stop: () => {
      track.stopCount.value += 1;
    },
  } as unknown as MediaStreamTrack & { stopCount: { value: number } };
  return track;
}

function stream(...tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  } as unknown as MediaStream;
}

function joinRoom(): CallSessionService {
  const service = new CallSessionService();
  void service.join(createRoomId());
  return service;
}

async function joined(service: CallSessionService, peerPresent = false): Promise<FakeWebSocket> {
  await Promise.resolve();
  const socket = FakeWebSocket.latest;
  if (!socket) throw new Error('WebSocket was not opened.');
  socket.receive({
    type: 'joined',
    payload: { participantId: 'abcdefghijklmnop', polite: false, peerPresent },
  });
  if (peerPresent)
    socket.receive({ type: 'peer-joined', payload: { participantId: 'qrstuvwxyzabcdef' } });
  return socket;
}

describe('CallSessionService', () => {
  let audioTrack: ReturnType<typeof mediaTrack>;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let getDisplayMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    peerHarness.created = [];
    FakeWebSocket.latest = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'MediaStream',
      class FakeMediaStream {
        constructor(private readonly tracks: MediaStreamTrack[] = []) {}
        getTracks(): MediaStreamTrack[] {
          return this.tracks;
        }
        getAudioTracks(): MediaStreamTrack[] {
          return this.tracks.filter((track) => track.kind === 'audio');
        }
        getVideoTracks(): MediaStreamTrack[] {
          return this.tracks.filter((track) => track.kind === 'video');
        }
      },
    );
    audioTrack = mediaTrack('audio');
    getUserMedia = vi.fn().mockResolvedValue(stream(audioTrack));
    getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, getDisplayMedia },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('joins with microphone only and starts the peer when the other participant arrives', async () => {
    const service = joinRoom();
    const socket = await joined(service);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(service.state()).toBe('waiting-for-peer');
    socket.receive({ type: 'peer-joined', payload: { participantId: 'qrstuvwxyzabcdef' } });
    expect(peerHarness.created).toHaveLength(1);
    expect(service.state()).toBe('connecting');
    service.leave();
  });

  it('starts and stops camera without affecting the audio session', async () => {
    const camera = mediaTrack('video');
    getUserMedia.mockResolvedValueOnce(stream(audioTrack)).mockResolvedValueOnce(stream(camera));
    const service = joinRoom();
    const socket = await joined(service, true);
    await service.toggleCamera();
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: true });
    expect(service.cameraEnabled()).toBe(true);
    expect(peerHarness.created[0]?.tracks).toEqual([camera]);
    await service.toggleCamera();
    expect(peerHarness.created[0]?.tracks.at(-1)).toBeNull();
    expect(camera.stopCount.value).toBe(1);
    expect(service.state()).toBe('connecting');
    service.leave();
    expect(socket.closed).toBe(true);
  });

  it('keeps audio available when camera permission fails', async () => {
    getUserMedia
      .mockResolvedValueOnce(stream(audioTrack))
      .mockRejectedValueOnce(new Error('denied'));
    const service = joinRoom();
    await joined(service, true);
    await service.toggleCamera();
    expect(service.cameraEnabled()).toBe(false);
    expect(service.cameraError()).toContain('Camera access');
    expect(service.state()).toBe('connecting');
    service.leave();
  });

  it('replaces camera with screen and restores camera when sharing stops', async () => {
    const camera = mediaTrack('video');
    const display = mediaTrack('video');
    getUserMedia.mockResolvedValueOnce(stream(audioTrack)).mockResolvedValueOnce(stream(camera));
    getDisplayMedia.mockResolvedValue(stream(display));
    const service = joinRoom();
    await joined(service, true);
    await service.toggleCamera();
    await service.toggleScreenSharing();
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(peerHarness.created[0]?.tracks).toEqual([camera, display]);
    expect(service.screenSharing()).toBe(true);
    await service.stopScreenSharing();
    expect(peerHarness.created[0]?.tracks.at(-1)).toBe(camera);
    expect(service.screenSharing()).toBe(false);
    expect(camera.stopCount.value).toBe(0);
    service.leave();
  });

  it('restores camera when the browser ends screen capture and tolerates a cancelled picker', async () => {
    const camera = mediaTrack('video');
    const display = mediaTrack('video');
    getUserMedia.mockResolvedValueOnce(stream(audioTrack)).mockResolvedValueOnce(stream(camera));
    getDisplayMedia
      .mockResolvedValueOnce(stream(display))
      .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    const service = joinRoom();
    await joined(service, true);
    await service.toggleCamera();
    await service.toggleScreenSharing();
    display.onended?.(new Event('ended'));
    await Promise.resolve();
    await Promise.resolve();
    expect(service.screenSharing()).toBe(false);
    expect(peerHarness.created[0]?.tracks.at(-1)).toBe(camera);
    await service.toggleScreenSharing();
    expect(service.screenSharing()).toBe(false);
    expect(service.state()).toBe('connecting');
    service.leave();
  });

  it('preserves selected media when a peer leaves and cleans every track on leave and destroy', async () => {
    const camera = mediaTrack('video');
    const display = mediaTrack('video');
    getUserMedia.mockResolvedValueOnce(stream(audioTrack)).mockResolvedValueOnce(stream(camera));
    getDisplayMedia.mockResolvedValue(stream(display));
    const service = joinRoom();
    const socket = await joined(service, true);
    await service.toggleCamera();
    await service.toggleScreenSharing();
    socket.receive({ type: 'peer-left', payload: {} });
    expect(service.state()).toBe('waiting-for-peer');
    expect(service.cameraEnabled()).toBe(true);
    expect(service.screenSharing()).toBe(true);
    socket.receive({ type: 'peer-joined', payload: { participantId: 'qrstuvwxyzabcdef' } });
    expect(peerHarness.created).toHaveLength(2);
    expect(peerHarness.created[1]?.tracks.at(-1)).toBe(display);
    service.leave();
    expect(audioTrack.stopCount.value).toBe(1);
    expect(camera.stopCount.value).toBe(1);
    expect(display.stopCount.value).toBe(1);
    expect(service.localVideoStream()).toBeNull();

    const secondAudio = mediaTrack('audio');
    getUserMedia.mockResolvedValueOnce(stream(secondAudio));
    const secondService = joinRoom();
    await joined(secondService);
    secondService.ngOnDestroy();
    expect(secondAudio.stopCount.value).toBe(1);
  });
});
