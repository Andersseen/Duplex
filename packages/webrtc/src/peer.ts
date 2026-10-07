import { deriveConnectionState } from './connection-state';
import type { DuplexConnectionState } from './connection-state';
import type {
  DuplexPeer,
  PeerEvent,
  PeerEventListener,
  PeerSignalingMessage,
  SignalingTransport,
} from './types';

export interface PeerOptions {
  readonly polite: boolean;
  readonly localStream: MediaStream;
  readonly iceServers?: RTCIceServer[];
  readonly createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  readonly createIceCandidate?: (candidate: RTCIceCandidateInit) => RTCIceCandidate;
}

/** Create a media peer using perfect negotiation. The signaling transport is owned by the caller. */
export function createDuplexPeer(transport: SignalingTransport, options: PeerOptions): DuplexPeer {
  const createConnection =
    options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration));
  const createIceCandidate =
    options.createIceCandidate ?? ((candidate) => new RTCIceCandidate(candidate));
  const connection = createConnection({
    iceServers: options.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  // Keep one stable outgoing video sender so camera and display tracks can be swapped without
  // rebuilding the peer connection or negotiating a second video track.
  const videoSender = connection.addTransceiver('video', { direction: 'sendrecv' }).sender;
  let makingOffer = false;
  let ignoreOffer = false;
  let isSettingRemoteAnswerPending = false;
  const pendingCandidates: (RTCIceCandidateInit | null)[] = [];
  let hasConnected = false;
  let closed = false;
  let connectionState: DuplexConnectionState = 'idle';
  const listeners = new Set<PeerEventListener>();
  const remoteTracks = new Map<string, MediaStreamTrack>();
  const emitRemoteMedia = (): void => {
    const tracks = [...remoteTracks.values()];
    const audioTracks = tracks.filter((track) => track.kind === 'audio');
    const videoTracks = tracks.filter(
      (track) => track.kind === 'video' && !track.muted && track.readyState !== 'ended',
    );
    emit({
      type: 'remote-media',
      media: {
        audio: audioTracks.length ? new MediaStream(audioTracks) : null,
        video: videoTracks.length ? new MediaStream(videoTracks) : null,
      },
    });
  };

  const emit = (event: PeerEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const emitState = (): void => {
    if (connection.connectionState === 'connected') hasConnected = true;
    connectionState = deriveConnectionState({
      connectionState: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      hasConnected,
    });
    emit({ type: 'connection-state', state: connectionState });
  };
  const emitFailure = (): void => {
    connectionState = 'failed';
    emit({ type: 'connection-state', state: 'failed' });
  };
  const sendDescription = (description: RTCSessionDescription | null): void => {
    if (!description) return;
    if (description.type === 'offer')
      transport.send({ type: 'offer', payload: { sdp: description.sdp } });
    else if (description.type === 'answer')
      transport.send({ type: 'answer', payload: { sdp: description.sdp } });
  };

  for (const track of options.localStream.getAudioTracks())
    connection.addTrack(track, options.localStream);

  connection.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await connection.setLocalDescription();
      sendDescription(connection.localDescription);
    } catch {
      emitFailure();
    } finally {
      makingOffer = false;
    }
  };

  connection.onicecandidate = (event) => {
    const candidate = event.candidate;
    transport.send({
      type: 'ice-candidate',
      payload: {
        candidate: candidate
          ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
              ...(candidate.usernameFragment == null
                ? {}
                : { usernameFragment: candidate.usernameFragment }),
            }
          : null,
      },
    });
  };

  connection.ontrack = (event) => {
    for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
      remoteTracks.set(track.id, track);
      if (track.kind === 'video') {
        track.onmute = emitRemoteMedia;
        track.onunmute = emitRemoteMedia;
      }
      track.onended = () => {
        remoteTracks.delete(track.id);
        emitRemoteMedia();
      };
    }
    emitRemoteMedia();
  };

  connection.onconnectionstatechange = emitState;
  connection.oniceconnectionstatechange = emitState;

  const unsubscribe = transport.subscribe((message) => {
    void handleMessage(message);
  });

  async function handleMessage(message: PeerSignalingMessage): Promise<void> {
    try {
      if (message.type === 'ice-candidate') {
        if (ignoreOffer) return;
        const candidate = message.payload.candidate;
        const candidateInit: RTCIceCandidateInit | null = candidate
          ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
              ...(candidate.usernameFragment === undefined
                ? {}
                : { usernameFragment: candidate.usernameFragment }),
            }
          : null;
        if (!connection.remoteDescription) pendingCandidates.push(candidateInit);
        else
          await connection.addIceCandidate(
            candidateInit ? createIceCandidate(candidateInit) : null,
          );
        return;
      }

      const description: RTCSessionDescriptionInit = {
        type: message.type,
        sdp: message.payload.sdp,
      };
      const readyForOffer =
        !makingOffer && (connection.signalingState === 'stable' || isSettingRemoteAnswerPending);
      const offerCollision = message.type === 'offer' && !readyForOffer;
      ignoreOffer = !options.polite && offerCollision;
      if (ignoreOffer) {
        pendingCandidates.length = 0;
        return;
      }

      isSettingRemoteAnswerPending = message.type === 'answer';
      await connection.setRemoteDescription(description);
      isSettingRemoteAnswerPending = false;
      for (const candidate of pendingCandidates.splice(0)) {
        await connection.addIceCandidate(candidate ? createIceCandidate(candidate) : null);
      }
      if (message.type === 'offer') {
        await connection.setLocalDescription();
        sendDescription(connection.localDescription);
      }
    } catch {
      isSettingRemoteAnswerPending = false;
      if (message.type === 'ice-candidate') emitState();
      else emitFailure();
    }
  }

  return {
    get connectionState() {
      return connectionState;
    },
    setVideoTrack(track): Promise<void> {
      return videoSender.replaceTrack(track);
    },
    subscribe(listener: PeerEventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      connection.onnegotiationneeded = null;
      connection.onicecandidate = null;
      connection.ontrack = null;
      connection.onconnectionstatechange = null;
      connection.oniceconnectionstatechange = null;
      connection.close();
      for (const track of remoteTracks.values()) {
        track.onmute = null;
        track.onunmute = null;
        track.onended = null;
      }
      remoteTracks.clear();
      connectionState = 'closed';
      emit({ type: 'connection-state', state: 'closed' });
      listeners.clear();
    },
  };
}
