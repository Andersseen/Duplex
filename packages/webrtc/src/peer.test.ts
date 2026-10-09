import { describe, expect, it, vi } from 'vitest';
import type { PeerSignalingMessage, SignalingTransport } from './types';
import type { DuplexDataChannel } from './types';
import { createDuplexPeer } from './peer';

class FakeTransport implements SignalingTransport {
  readonly sent: PeerSignalingMessage[] = [];
  private readonly listeners = new Set<(message: PeerSignalingMessage) => void>();
  send(message: PeerSignalingMessage): void {
    this.sent.push(message);
  }
  subscribe(listener: (message: PeerSignalingMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  receive(message: PeerSignalingMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  onopen: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onclose: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onmessage: ((this: RTCDataChannel, ev: MessageEvent) => unknown) | null = null;
  onbufferedamountlow: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  readonly sent: (string | ArrayBuffer)[] = [];
  constructor(readonly label: string) {}
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.call(this as unknown as RTCDataChannel, new Event('open'));
  }
  message(data: string | ArrayBuffer): void {
    this.onmessage?.call(this as unknown as RTCDataChannel, new MessageEvent('message', { data }));
  }
  close(): void {
    this.readyState = 'closed';
    this.onclose?.call(this as unknown as RTCDataChannel, new Event('close'));
  }
}

class FakeConnection {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onnegotiationneeded: ((this: RTCPeerConnection, event: Event) => unknown) | null = null;
  onicecandidate: ((this: RTCPeerConnection, event: RTCPeerConnectionIceEvent) => unknown) | null =
    null;
  ontrack: ((this: RTCPeerConnection, event: RTCTrackEvent) => unknown) | null = null;
  ondatachannel: ((this: RTCPeerConnection, event: RTCDataChannelEvent) => unknown) | null = null;
  onconnectionstatechange: ((this: RTCPeerConnection, event: Event) => unknown) | null = null;
  oniceconnectionstatechange: ((this: RTCPeerConnection, event: Event) => unknown) | null = null;
  readonly candidates: (RTCIceCandidate | null)[] = [];
  closed = false;
  addTrackCalls = 0;
  addTransceiverCalls = 0;
  readonly replacedTracks: (MediaStreamTrack | null)[] = [];
  readonly restarted = { count: 0 };
  readonly dataChannels: FakeDataChannel[] = [];
  readonly dataChannelOptions: (RTCDataChannelInit | undefined)[] = [];
  configuration: RTCConfiguration = {};
  candidateStats: RTCStats[] = [];
  readonly videoSender = {
    replaceTrack: (track: MediaStreamTrack | null) => {
      this.replacedTracks.push(track);
      return Promise.resolve();
    },
  };
  addTrack(): void {
    this.addTrackCalls += 1;
  }
  addTransceiver(): RTCRtpTransceiver {
    this.addTransceiverCalls += 1;
    return { sender: this.videoSender } as unknown as RTCRtpTransceiver;
  }
  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    this.dataChannelOptions.push(options);
    const channel = new FakeDataChannel(label);
    this.dataChannels.push(channel);
    return channel as unknown as RTCDataChannel;
  }
  setLocalDescription(): Promise<void> {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `v=0 ${type}` } as RTCSessionDescription;
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
    return Promise.resolve();
  }
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    return Promise.resolve();
  }
  addIceCandidate(candidate: RTCIceCandidate | null): Promise<void> {
    this.candidates.push(candidate);
    return Promise.resolve();
  }
  getConfiguration(): RTCConfiguration {
    return this.configuration;
  }
  setConfiguration(configuration: RTCConfiguration): void {
    this.configuration = configuration;
  }
  restartIce(): void {
    this.restarted.count += 1;
  }
  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(
      new Map(this.candidateStats.map((stat) => [stat.id, stat])) as unknown as RTCStatsReport,
    );
  }
  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
  asPeerConnection(): RTCPeerConnection {
    return this as unknown as RTCPeerConnection;
  }
}

function createLocalStream(): MediaStream {
  return { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
}

describe('createDuplexPeer', () => {
  it('waits for the impolite peer offer and answers it on the polite side', async () => {
    const transport = new FakeTransport();
    const connection = new FakeConnection();
    const remoteCandidate = { candidate: 'candidate:1' } as RTCIceCandidate;
    const peer = createDuplexPeer(transport, {
      polite: true,
      localStream: createLocalStream(),
      createPeerConnection: () => connection.asPeerConnection(),
      createIceCandidate: () => remoteCandidate,
    });

    await connection.onnegotiationneeded?.call(
      connection.asPeerConnection(),
      new Event('negotiationneeded'),
    );
    expect(transport.sent).toEqual([]);
    transport.receive({ type: 'offer', payload: { sdp: 'v=0 remote' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(connection.remoteDescription?.type).toBe('offer');
    expect(transport.sent.at(-1)?.type).toBe('answer');
    transport.receive({ type: 'ice-candidate', payload: { candidate: null } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connection.candidates).toEqual([null]);
    transport.receive({
      type: 'ice-candidate',
      payload: {
        candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connection.candidates[1]).toBe(remoteCandidate);
    connection.onicecandidate?.call(connection.asPeerConnection(), {
      candidate: null,
    } as RTCPeerConnectionIceEvent);
    expect(transport.sent.at(-1)).toEqual({ type: 'ice-candidate', payload: { candidate: null } });
    peer.close();
    expect(connection.closed).toBe(true);
  });

  it('lets the impolite peer create the initial offer', async () => {
    const transport = new FakeTransport();
    const connection = new FakeConnection();
    const peer = createDuplexPeer(transport, {
      polite: false,
      localStream: createLocalStream(),
      createPeerConnection: () => connection.asPeerConnection(),
    });
    await connection.onnegotiationneeded?.call(
      connection.asPeerConnection(),
      new Event('negotiationneeded'),
    );
    expect(transport.sent[0]?.type).toBe('offer');
    peer.close();
  });

  it('queues ICE until remote description and ignores colliding offers when impolite', async () => {
    const transport = new FakeTransport();
    const connection = new FakeConnection();
    connection.signalingState = 'have-local-offer';
    const peer = createDuplexPeer(transport, {
      polite: false,
      localStream: createLocalStream(),
      createPeerConnection: () => connection.asPeerConnection(),
    });
    transport.receive({ type: 'ice-candidate', payload: { candidate: null } });
    transport.receive({ type: 'offer', payload: { sdp: 'v=0 collided' } });
    await Promise.resolve();
    expect(connection.remoteDescription).toBeNull();
    expect(connection.candidates).toHaveLength(0);
    peer.close();
  });

  it('uses one stable video sender to switch camera, screen, and disabled states', async () => {
    const transport = new FakeTransport();
    const connection = new FakeConnection();
    const peer = createDuplexPeer(transport, {
      polite: true,
      localStream: createLocalStream(),
      createPeerConnection: () => connection.asPeerConnection(),
    });
    const camera = { kind: 'video' } as MediaStreamTrack;
    const screen = { kind: 'video' } as MediaStreamTrack;

    await peer.setVideoTrack(camera);
    await peer.setVideoTrack(screen);
    await peer.setVideoTrack(camera);
    await peer.setVideoTrack(null);

    expect(connection.addTransceiverCalls).toBe(1);
    expect(connection.replacedTracks).toEqual([camera, screen, camera, null]);
    expect(connection.closed).toBe(false);
    peer.close();
    expect(connection.closed).toBe(true);
  });

  it('creates dedicated channels with their delivery semantics and accepts each label once', () => {
    const ownerConnection = new FakeConnection();
    const owner = createDuplexPeer(new FakeTransport(), {
      polite: false,
      localStream: createLocalStream(),
      createPeerConnection: () => ownerConnection.asPeerConnection(),
    });
    expect(ownerConnection.dataChannels).toHaveLength(5);
    expect(ownerConnection.dataChannels[0]?.label).toBe('duplex-file-transfer');
    expect(ownerConnection.dataChannels[1]?.label).toBe('duplex-collaboration');
    expect(ownerConnection.dataChannels[2]?.label).toBe('duplex-pointer');
    expect(ownerConnection.dataChannels[3]?.label).toBe('duplex-control');
    expect(ownerConnection.dataChannels[4]?.label).toBe('duplex-input');
    expect(ownerConnection.dataChannelOptions).toEqual([
      { ordered: true },
      { ordered: true },
      { ordered: false, maxRetransmits: 0 },
      { ordered: true },
      { ordered: true },
    ]);
    const ownerEvents: string[] = [];
    let ownerChannel: DuplexDataChannel | undefined;
    const received: (string | ArrayBuffer)[] = [];
    owner.subscribe((event) => {
      if (event.type === 'data-channel') {
        ownerEvents.push('channel');
        if (event.channel.label === 'duplex-file-transfer') ownerChannel = event.channel;
        event.channel.subscribe((channelEvent) => {
          if (channelEvent.type === 'message') received.push(channelEvent.data);
        });
      }
      if (event.type === 'data-channel-open') ownerEvents.push('open');
    });
    const raw = ownerConnection.dataChannels[0];
    if (!raw) throw new Error('Impolite peer did not create its file channel.');
    raw.open();
    expect(ownerEvents).toEqual(['channel', 'channel', 'channel', 'channel', 'channel', 'open']);
    ownerChannel?.sendText('control');
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    ownerChannel?.sendBinary(bytes);
    expect(raw.sent).toEqual(['control', bytes]);
    raw.message('reply');
    raw.message(bytes);
    expect(received).toEqual(['reply', bytes]);

    const politeConnection = new FakeConnection();
    const polite = createDuplexPeer(new FakeTransport(), {
      polite: true,
      localStream: createLocalStream(),
      createPeerConnection: () => politeConnection.asPeerConnection(),
    });
    expect(politeConnection.dataChannels).toHaveLength(0);
    const accepted: string[] = [];
    polite.subscribe((event) => {
      if (event.type === 'data-channel') accepted.push(event.channel.label);
    });
    const incoming = [
      'duplex-file-transfer',
      'duplex-collaboration',
      'duplex-pointer',
      'duplex-control',
      'duplex-input',
    ].map((label) => new FakeDataChannel(label));
    for (const channel of incoming)
      politeConnection.ondatachannel?.call(politeConnection.asPeerConnection(), {
        channel: channel as unknown as RTCDataChannel,
      } as RTCDataChannelEvent);
    expect(accepted).toEqual(incoming.map((channel) => channel.label));
    expect(incoming[0]?.binaryType).toBe('arraybuffer');
    const duplicate = new FakeDataChannel('duplex-control');
    politeConnection.ondatachannel?.call(politeConnection.asPeerConnection(), {
      channel: duplicate as unknown as RTCDataChannel,
    } as RTCDataChannelEvent);
    const unknown = new FakeDataChannel('unknown');
    politeConnection.ondatachannel?.call(politeConnection.asPeerConnection(), {
      channel: unknown as unknown as RTCDataChannel,
    } as RTCDataChannelEvent);
    expect(accepted).toHaveLength(5);
    expect(duplicate.readyState).toBe('closed');
    expect(unknown.readyState).toBe('closed');
    expect(politeConnection.closed).toBe(false);
    incoming[3]?.close();
    expect(incoming[0]?.readyState).not.toBe('closed');
    expect(incoming[1]?.readyState).not.toBe('closed');
    owner.close();
    polite.close();
    expect(ownerConnection.dataChannels.every((channel) => channel.readyState === 'closed')).toBe(
      true,
    );
    expect(incoming.every((channel) => channel.readyState === 'closed')).toBe(true);

    const replacementConnection = new FakeConnection();
    const replacement = createDuplexPeer(new FakeTransport(), {
      polite: false,
      localStream: createLocalStream(),
      createPeerConnection: () => replacementConnection.asPeerConnection(),
    });
    expect(replacementConnection.dataChannels).toHaveLength(5);
    expect(replacementConnection.dataChannels[0]).not.toBe(raw);
    replacement.close();
  });

  it('creates duplex-input as reliable ordered on the impolite side and accepts it once on the polite side', () => {
    const ownerConnection = new FakeConnection();
    const owner = createDuplexPeer(new FakeTransport(), {
      polite: false,
      localStream: createLocalStream(),
      createPeerConnection: () => ownerConnection.asPeerConnection(),
    });
    const inputIndex = ownerConnection.dataChannels.findIndex(
      (channel) => channel.label === 'duplex-input',
    );
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    const options = ownerConnection.dataChannelOptions[inputIndex];
    expect(options).toEqual({ ordered: true });
    expect(options).not.toHaveProperty('maxRetransmits');
    expect(options).not.toHaveProperty('maxPacketLifeTime');

    const politeConnection = new FakeConnection();
    const polite = createDuplexPeer(new FakeTransport(), {
      polite: true,
      localStream: createLocalStream(),
      createPeerConnection: () => politeConnection.asPeerConnection(),
    });
    expect(politeConnection.dataChannels).toHaveLength(0);
    const labels: string[] = [];
    polite.subscribe((event) => {
      if (event.type === 'data-channel') labels.push(event.channel.label);
    });
    const deliver = (channel: FakeDataChannel): void => {
      politeConnection.ondatachannel?.call(politeConnection.asPeerConnection(), {
        channel: channel as unknown as RTCDataChannel,
      } as RTCDataChannelEvent);
    };
    const input = new FakeDataChannel('duplex-input');
    const control = new FakeDataChannel('duplex-control');
    deliver(input);
    deliver(control);
    const duplicate = new FakeDataChannel('duplex-input');
    deliver(duplicate);
    expect(labels).toEqual(['duplex-input', 'duplex-control']);
    expect(duplicate.readyState).toBe('closed');
    expect(input.readyState).not.toBe('closed');

    // Closing input leaves every other channel and the connection alone.
    input.close();
    expect(control.readyState).not.toBe('closed');
    expect(politeConnection.closed).toBe(false);
    // A closed label is released, so a replacement input channel can be accepted.
    const replacement = new FakeDataChannel('duplex-input');
    deliver(replacement);
    expect(labels).toEqual(['duplex-input', 'duplex-control', 'duplex-input']);

    owner.close();
    polite.close();
    expect(ownerConnection.dataChannels.every((channel) => channel.readyState === 'closed')).toBe(
      true,
    );
    expect(control.readyState).toBe('closed');
    expect(replacement.readyState).toBe('closed');
  });

  it('uses supplied ICE servers and updates them without rebuilding the peer', () => {
    const transport = new FakeTransport();
    const connection = new FakeConnection();
    const initialIceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    const peer = createDuplexPeer(transport, {
      polite: true,
      localStream: createLocalStream(),
      iceServers: initialIceServers,
      createPeerConnection: (configuration) => {
        connection.configuration = configuration;
        return connection.asPeerConnection();
      },
    });
    expect(connection.configuration.iceServers).toEqual(initialIceServers);
    const updated = [
      { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'user', credential: 'pass' },
    ];
    peer.updateIceServers(updated);
    expect(connection.configuration.iceServers).toEqual(updated);
    expect(connection.closed).toBe(false);
    peer.close();
  });

  it('restarts ICE and retains perfect negotiation for the restart offer', async () => {
    const transport = new FakeTransport();
    const connection = new FakeConnection();
    const peer = createDuplexPeer(transport, {
      polite: true,
      localStream: createLocalStream(),
      createPeerConnection: () => connection.asPeerConnection(),
    });
    connection.remoteDescription = { type: 'offer', sdp: 'v=0 remote' } as RTCSessionDescription;
    peer.restartIce();
    expect(connection.restarted.count).toBe(1);
    await connection.onnegotiationneeded?.call(
      connection.asPeerConnection(),
      new Event('negotiationneeded'),
    );
    expect(transport.sent.at(-1)?.type).toBe('offer');
    peer.close();
  });

  it('reports direct and relay candidate paths after connection', async () => {
    for (const [candidateType, expected] of [
      ['host', 'direct'],
      ['relay', 'relay'],
    ] as const) {
      const transport = new FakeTransport();
      const connection = new FakeConnection();
      connection.candidateStats = [
        {
          id: 'pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'local',
        } as unknown as RTCStats,
        {
          id: 'local',
          type: 'local-candidate',
          candidateType,
        } as unknown as RTCStats,
      ];
      const peer = createDuplexPeer(transport, {
        polite: true,
        localStream: createLocalStream(),
        createPeerConnection: () => connection.asPeerConnection(),
      });
      const paths: string[] = [];
      peer.subscribe((event) => {
        if (event.type === 'connection-path') paths.push(event.path);
      });
      connection.connectionState = 'connected';
      connection.iceConnectionState = 'connected';
      connection.onconnectionstatechange?.call(
        connection.asPeerConnection(),
        new Event('statechange'),
      );
      await Promise.resolve();
      expect(paths.at(-1)).toBe(expected);
      peer.close();
    }
  });

  it('restarts a disconnected ICE session twice at most, then reports failure', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const connection = new FakeConnection();
      const peer = createDuplexPeer(transport, {
        polite: true,
        localStream: createLocalStream(),
        createPeerConnection: () => connection.asPeerConnection(),
      });
      const states: string[] = [];
      peer.subscribe((event) => {
        if (event.type === 'connection-state') states.push(event.state);
      });
      connection.connectionState = 'connected';
      connection.iceConnectionState = 'connected';
      connection.onconnectionstatechange?.call(
        connection.asPeerConnection(),
        new Event('statechange'),
      );
      connection.connectionState = 'connected';
      connection.iceConnectionState = 'disconnected';
      connection.onconnectionstatechange?.call(
        connection.asPeerConnection(),
        new Event('statechange'),
      );
      expect(states.at(-1)).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(2500);
      expect(connection.restarted.count).toBe(1);
      await vi.advanceTimersByTimeAsync(8000);
      await vi.advanceTimersByTimeAsync(1);
      expect(connection.restarted.count).toBe(2);
      await vi.advanceTimersByTimeAsync(8000);
      expect(states.at(-1)).toBe('failed');
      peer.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fail recovery when ICE reaches completed', async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      const peer = createDuplexPeer(new FakeTransport(), {
        polite: true,
        localStream: createLocalStream(),
        createPeerConnection: () => connection.asPeerConnection(),
      });
      const states: string[] = [];
      peer.subscribe((event) => {
        if (event.type === 'connection-state') states.push(event.state);
      });
      connection.connectionState = 'connected';
      connection.iceConnectionState = 'connected';
      connection.onconnectionstatechange?.call(connection.asPeerConnection(), new Event('change'));
      connection.iceConnectionState = 'disconnected';
      connection.oniceconnectionstatechange?.call(
        connection.asPeerConnection(),
        new Event('change'),
      );
      await vi.advanceTimersByTimeAsync(2500);
      expect(connection.restarted.count).toBe(1);
      connection.iceConnectionState = 'completed';
      connection.oniceconnectionstatechange?.call(
        connection.asPeerConnection(),
        new Event('change'),
      );
      expect(states.at(-1)).toBe('connected');
      await vi.advanceTimersByTimeAsync(8000);
      expect(states).not.toContain('failed');
      peer.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
