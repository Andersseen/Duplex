import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const peerHarness = vi.hoisted(() => ({
  created: [] as {
    tracks: (MediaStreamTrack | null)[];
    close: ReturnType<typeof vi.fn>;
    options: unknown;
    signaling: unknown[];
    updateIceServers: ReturnType<typeof vi.fn>;
    emit: (event: unknown) => void;
  }[],
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
  createDuplexPeer: vi.fn((transport: unknown, options: unknown) => {
    const listeners: ((event: unknown) => void)[] = [];
    const signaling: unknown[] = [];
    const signalTransport = transport as {
      subscribe: (listener: (message: unknown) => void) => () => void;
    };
    const unsubscribeSignaling = signalTransport.subscribe((message) => {
      signaling.push(message);
    });
    const peer = {
      tracks: [] as (MediaStreamTrack | null)[],
      close: vi.fn(unsubscribeSignaling),
      connectionState: 'connecting',
      options,
      signaling,
      updateIceServers: vi.fn(),
      restartIce: vi.fn(),
      setVideoTrack: vi.fn((track: MediaStreamTrack | null) => {
        peer.tracks.push(track);
        return Promise.resolve();
      }),
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      emit: (event: unknown) => {
        listeners.forEach((listener) => {
          listener(event);
        });
      },
    };
    peerHarness.created.push(peer);
    return peer;
  }),
}));

import { CallSessionService } from './call-session.service';
import { createRoomId, decodeHelperPairingBundle } from '@duplex/protocol';

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
  socket.receive({
    type: 'rtc-config',
    payload: {
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      relayAvailable: false,
    },
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

  it('waits for server RTC configuration and passes it into the peer', async () => {
    const service = joinRoom();
    await Promise.resolve();
    const socket = FakeWebSocket.latest;
    if (!socket) throw new Error('WebSocket was not opened.');
    socket.receive({
      type: 'joined',
      payload: { participantId: 'abcdefghijklmnop', polite: true, peerPresent: true },
    });
    socket.receive({ type: 'peer-joined', payload: { participantId: 'qrstuvwxyzabcdef' } });
    expect(peerHarness.created).toHaveLength(0);
    socket.receive({
      type: 'rtc-config',
      payload: {
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478'] },
          {
            urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
            username: 'temp',
            credential: 'temp',
          },
        ],
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
        relayAvailable: true,
      },
    });
    expect(peerHarness.created).toHaveLength(1);
    expect(peerHarness.created[0]?.options).toMatchObject({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'temp',
          credential: 'temp',
        },
      ],
    });
    expect(peerHarness.created[0]?.updateIceServers).not.toHaveBeenCalled();
    service.leave();
  });

  it('delivers signaling received before RTC configuration creates the peer', async () => {
    const service = joinRoom();
    await Promise.resolve();
    const socket = FakeWebSocket.latest;
    if (!socket) throw new Error('WebSocket was not opened.');
    socket.receive({
      type: 'joined',
      payload: { participantId: 'abcdefghijklmnop', polite: true, peerPresent: true },
    });
    socket.receive({ type: 'offer', payload: { sdp: 'v=0 early-offer' } });
    expect(peerHarness.created).toHaveLength(0);
    socket.receive({
      type: 'rtc-config',
      payload: {
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
        relayAvailable: false,
      },
    });
    expect(peerHarness.created[0]?.signaling).toEqual([
      { type: 'offer', payload: { sdp: 'v=0 early-offer' } },
    ]);
    service.leave();
  });

  it('updates existing peer ICE servers on refresh and clears the refresh timer on leave', async () => {
    vi.useFakeTimers();
    try {
      const service = joinRoom();
      const socket = await joined(service, true);
      const peer = peerHarness.created[0];
      expect(peer).toBeDefined();
      socket.receive({
        type: 'rtc-config',
        payload: {
          iceServers: [
            {
              urls: 'turn:turn.cloudflare.com:3478?transport=udp',
              username: 'new',
              credential: 'new',
            },
          ],
          expiresAt: Date.now() + 12 * 60 * 60 * 1000,
          relayAvailable: true,
        },
      });
      expect(peer?.updateIceServers).toHaveBeenCalledWith([
        { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'new', credential: 'new' },
      ]);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      service.leave();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces ICE recovery and connection path, and explains direct failure when relay is unavailable', async () => {
    const service = joinRoom();
    await joined(service, true);
    const peer = peerHarness.created[0];
    peer?.emit({ type: 'connection-state', state: 'reconnecting' });
    expect(service.state()).toBe('reconnecting');
    peer?.emit({ type: 'connection-state', state: 'connected' });
    expect(service.state()).toBe('connected');
    peer?.emit({ type: 'connection-path', path: 'direct' });
    expect(service.connectionPath()).toBe('direct');
    peer?.emit({ type: 'connection-state', state: 'failed' });
    expect(service.state()).toBe('failed');
    expect(service.sessionError()).toContain('TURN relay is unavailable');
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

  describe('native pointer control', () => {
    function displayTrack(displaySurface?: string): ReturnType<typeof mediaTrack> {
      const track = mediaTrack('video');
      (track as unknown as { getSettings: () => MediaTrackSettings }).getSettings = () =>
        displaySurface ? { displaySurface } : {};
      return track;
    }

    function fakeChannel(label: string): {
      label: string;
      state: string;
      bufferedAmount: number;
      bufferedAmountLowThreshold: number;
      sent: string[];
      listeners: Set<(event: unknown) => void>;
      sendText: (value: string) => void;
      subscribe: (listener: (event: unknown) => void) => () => void;
      close: () => void;
      emit: (event: unknown) => void;
    } {
      const listeners = new Set<(event: unknown) => void>();
      const channel = {
        label,
        state: 'open',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        sent: [] as string[],
        listeners,
        sendText: (value: string) => channel.sent.push(value),
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: () => undefined,
        emit: (event: unknown) => {
          for (const listener of listeners) listener(event);
        },
      };
      return channel;
    }

    it.each([
      ['monitor', ['pointer']],
      ['window', []],
      ['browser', []],
      [undefined, []],
    ])('derives native capability from displaySurface %s', async (surface, expected) => {
      getDisplayMedia.mockResolvedValue(stream(displayTrack(surface)));
      const service = joinRoom();
      const socket = await joined(service, true);
      await service.toggleScreenSharing();
      socket.receive({ type: 'helper-paired', payload: {} });
      socket.receive({ type: 'helper-capabilities', payload: { availableScopes: ['pointer'] } });
      expect(service.control.localAvailableScopes()).toEqual(expected);
      service.leave();
    });

    it('does not advertise keyboard even if the helper claims it', async () => {
      getDisplayMedia.mockResolvedValue(stream(displayTrack('monitor')));
      const service = joinRoom();
      const socket = await joined(service, true);
      await service.toggleScreenSharing();
      socket.receive({ type: 'helper-paired', payload: {} });
      socket.receive({
        type: 'helper-capabilities',
        payload: { availableScopes: ['pointer', 'keyboard'] },
      });
      expect(service.control.localAvailableScopes()).toEqual(['pointer']);
      service.leave();
    });

    it('relays validated input to the helper, honours local stop, and stops after revoke', async () => {
      getDisplayMedia.mockResolvedValue(stream(displayTrack('monitor')));
      const service = joinRoom();
      const socket = await joined(service, true);
      await service.toggleScreenSharing();
      socket.receive({ type: 'helper-paired', payload: {} });
      socket.receive({ type: 'helper-capabilities', payload: { availableScopes: ['pointer'] } });
      const controlChannel = fakeChannel('duplex-control');
      const inputChannel = fakeChannel('duplex-input');
      peerHarness.created[0]?.emit({ type: 'data-channel', channel: controlChannel });
      peerHarness.created[0]?.emit({ type: 'data-channel', channel: inputChannel });
      const surfaceId = service.collaboration.localSurfaceId();
      controlChannel.emit({
        type: 'message',
        data: JSON.stringify({
          type: 'control-request',
          protocolVersion: 1,
          surfaceId,
          requestId: crypto.randomUUID(),
          scopes: ['pointer'],
        }),
      });
      service.control.allow();
      const session = service.control.session();
      if (!session) throw new Error('Control was not granted.');
      const helperMessages = (): { type: string }[] =>
        socket.sent.map((value) => JSON.parse(value) as { type: string });
      expect(helperMessages().some((m) => m.type === 'helper-session-authorized')).toBe(true);

      const input = {
        type: 'input-pointer-move',
        protocolVersion: 1,
        controlSessionId: session.controlSessionId,
        surfaceId: session.surfaceId,
        sequence: 1,
        x: 0.4,
        y: 0.6,
      };
      inputChannel.emit({ type: 'message', data: JSON.stringify(input) });
      expect(helperMessages().filter((m) => m.type === 'helper-input')).toEqual([
        { type: 'helper-input', input },
      ]);

      // A stale session id never reaches the helper.
      inputChannel.emit({
        type: 'message',
        data: JSON.stringify({ ...input, controlSessionId: crypto.randomUUID(), sequence: 2 }),
      });
      expect(helperMessages().filter((m) => m.type === 'helper-input')).toHaveLength(1);

      // The local user stops control from the helper; the browser owns the revoke protocol.
      socket.receive({
        type: 'helper-stop-control',
        payload: { controlSessionId: session.controlSessionId },
      });
      expect(service.control.session()).toBeNull();
      expect(helperMessages().some((m) => m.type === 'helper-session-revoked')).toBe(true);
      expect(
        controlChannel.sent.map((value) => JSON.parse(value) as { type: string; reason?: string }),
      ).toContainEqual(expect.objectContaining({ type: 'control-revoked', reason: 'user' }));
      inputChannel.emit({ type: 'message', data: JSON.stringify({ ...input, sequence: 3 }) });
      expect(helperMessages().filter((m) => m.type === 'helper-input')).toHaveLength(1);

      // A stop for some other session id is ignored.
      socket.receive({
        type: 'helper-stop-control',
        payload: { controlSessionId: crypto.randomUUID() },
      });
      service.leave();
    });

    it('turns the collaboration tool off when this browser starts controlling', async () => {
      const service = joinRoom();
      await joined(service, true);
      const controlChannel = fakeChannel('duplex-control');
      const inputChannel = fakeChannel('duplex-input');
      peerHarness.created[0]?.emit({ type: 'data-channel', channel: controlChannel });
      peerHarness.created[0]?.emit({ type: 'data-channel', channel: inputChannel });
      const surfaceId = crypto.randomUUID();
      service.collaboration.setTool('pointer');
      service.control.setPeerMedia('screen', surfaceId);
      controlChannel.emit({
        type: 'message',
        data: JSON.stringify({
          type: 'control-capability',
          protocolVersion: 1,
          surfaceId,
          helperConnected: true,
          availableScopes: ['pointer'],
        }),
      });
      service.control.requestControl();
      const request = JSON.parse(controlChannel.sent.at(-1) ?? '{}') as { requestId: string };
      service.collaboration.setTool('draw');
      controlChannel.emit({
        type: 'message',
        data: JSON.stringify({
          type: 'control-granted',
          protocolVersion: 1,
          surfaceId,
          requestId: request.requestId,
          controlSessionId: crypto.randomUUID(),
          scopes: ['pointer'],
          expiresAt: Date.now() + 60_000,
        }),
      });
      expect(service.control.state()).toBe('controlling');
      expect(service.collaboration.tool()).toBe('off');
      service.leave();
    });
  });

  describe('helper pairing', () => {
    async function sharingService() {
      getDisplayMedia.mockResolvedValue(stream(mediaTrack('video')));
      const service = joinRoom();
      const socket = await joined(service, true);
      await service.toggleScreenSharing();
      return { service, socket };
    }

    it('only requests a pairing code while a screen is being shared', async () => {
      const service = joinRoom();
      const socket = await joined(service, true);

      service.createHelperPairingCode();
      expect(socket.sent.some((message) => message.includes('helper-pairing-create'))).toBe(false);

      getDisplayMedia.mockResolvedValue(stream(mediaTrack('video')));
      await service.toggleScreenSharing();
      service.createHelperPairingCode();
      expect(socket.sent.some((message) => message.includes('helper-pairing-create'))).toBe(true);
      service.leave();
    });

    it('wraps the server token in a bundle bound to this room and expires it locally', async () => {
      vi.useFakeTimers();
      try {
        const { service, socket } = await sharingService();
        socket.receive({
          type: 'helper-pairing-created',
          payload: { token: 'A'.repeat(43), expiresAt: Date.now() + 120_000 },
        });

        const code = service.helperPairingCode();
        expect(code).toBeTruthy();
        const bundle = decodeHelperPairingBundle(code ?? '');
        expect(bundle.token).toBe('A'.repeat(43));
        expect(bundle.roomId).toBe(socket.url.split('/rooms/')[1]?.split('/')[0]);

        await vi.advanceTimersByTimeAsync(120_001);
        expect(service.helperPairingCode()).toBeNull();
        service.leave();
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops the code once the helper pairs and tracks its connection', async () => {
      const { service, socket } = await sharingService();
      socket.receive({
        type: 'helper-pairing-created',
        payload: { token: 'B'.repeat(43), expiresAt: Date.now() + 120_000 },
      });
      expect(service.helperPairingCode()).not.toBeNull();

      socket.receive({ type: 'helper-paired', payload: {} });
      expect(service.helperConnected()).toBe(true);
      expect(service.helperPairingCode()).toBeNull();
      expect(service.helperPairingExpiresAt()).toBeNull();

      socket.receive({ type: 'helper-disconnected', payload: {} });
      expect(service.helperConnected()).toBe(false);
      service.leave();
    });

    it('forgets pairing state when the call is left', async () => {
      const { service, socket } = await sharingService();
      socket.receive({
        type: 'helper-pairing-created',
        payload: { token: 'C'.repeat(43), expiresAt: Date.now() + 120_000 },
      });

      service.leave();

      expect(service.helperPairingCode()).toBeNull();
      expect(service.helperConnected()).toBe(false);
    });

    it('reports whether the pairing code could be copied', async () => {
      const { service, socket } = await sharingService();
      await expect(service.copyHelperPairingCode()).resolves.toBe(false);
      socket.receive({
        type: 'helper-pairing-created',
        payload: { token: 'D'.repeat(43), expiresAt: Date.now() + 120_000 },
      });

      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      await expect(service.copyHelperPairingCode()).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith(service.helperPairingCode());

      writeText.mockRejectedValue(new Error('denied'));
      await expect(service.copyHelperPairingCode()).resolves.toBe(false);
      service.leave();
    });
  });

  describe('room failures', () => {
    it('explains a full room and closes the socket', async () => {
      const service = joinRoom();
      const socket = await joined(service);

      socket.receive({ type: 'room-full', payload: { reason: 'capacity' } });

      expect(service.state()).toBe('failed');
      expect(service.sessionError()).toContain('already has two participants');
      expect(socket.closed).toBe(true);
    });

    it('tells the user to reload on a protocol mismatch', async () => {
      const service = joinRoom();
      const socket = await joined(service);

      socket.receive({
        type: 'protocol-error',
        payload: { code: 'protocol_mismatch', message: 'old client' },
      });

      expect(service.state()).toBe('failed');
      expect(service.sessionError()).toContain('Reload the page');
    });

    it('surfaces other protocol errors verbatim', async () => {
      const service = joinRoom();
      const socket = await joined(service);

      socket.receive({
        type: 'protocol-error',
        payload: { code: 'invalid_message', message: 'Message must contain valid JSON.' },
      });

      expect(service.sessionError()).toBe('Message must contain valid JSON.');
    });

    it('fails when the socket errors or closes unexpectedly, but not on a normal close', async () => {
      const errored = joinRoom();
      await joined(errored);
      FakeWebSocket.latest?.onerror?.(new Event('error'));
      expect(errored.state()).toBe('failed');

      const dropped = joinRoom();
      await joined(dropped);
      FakeWebSocket.latest?.onclose?.(new CloseEvent('close', { code: 1006 }));
      expect(dropped.sessionError()).toContain('connection closed');

      const incompatible = joinRoom();
      await joined(incompatible);
      FakeWebSocket.latest?.onclose?.(new CloseEvent('close', { code: 4001 }));
      expect(incompatible.sessionError()).toContain('not compatible');

      const normal = joinRoom();
      await joined(normal);
      FakeWebSocket.latest?.onclose?.(new CloseEvent('close', { code: 1000 }));
      expect(normal.state()).toBe('waiting-for-peer');
      normal.leave();
    });

    it('gives up when the room never answers', async () => {
      vi.useFakeTimers();
      try {
        const service = joinRoom();
        await vi.advanceTimersByTimeAsync(10_001);

        expect(service.state()).toBe('failed');
        expect(service.sessionError()).toContain('did not respond');
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ['non-JSON text', '{not json', 'invalid message'],
      [
        'an unknown message type',
        JSON.stringify({ type: 'unknown-type', payload: {} }),
        'unsupported',
      ],
    ])('fails closed on %s from the room', async (_label, data, expected) => {
      const service = joinRoom();
      const socket = await joined(service);

      socket.onmessage?.(new MessageEvent('message', { data }));

      expect(service.state()).toBe('failed');
      expect(service.sessionError()).toContain(expected);
    });
  });
});
