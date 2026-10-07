import { describe, expect, it } from 'vitest';
import type { PeerSignalingMessage, SignalingTransport } from './types';
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
  onconnectionstatechange: ((this: RTCPeerConnection, event: Event) => unknown) | null = null;
  oniceconnectionstatechange: ((this: RTCPeerConnection, event: Event) => unknown) | null = null;
  readonly candidates: (RTCIceCandidate | null)[] = [];
  closed = false;
  addTrackCalls = 0;
  addTrack(): void {
    this.addTrackCalls += 1;
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
  it('offers after negotiation is needed and answers a remote offer', async () => {
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
    expect(transport.sent[0]?.type).toBe('offer');
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
});
