import { deriveConnectionState } from './connection-state';
import { createDuplexDataChannel } from './data-channel';
import { DATA_CHANNEL_LABELS } from './types';
import type { DuplexConnectionState } from './connection-state';
import type {
  ConnectionPath,
  DuplexDataChannel,
  DuplexOwnedDataChannelLabel,
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
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
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
    iceServers: options.iceServers ?? [{ urls: 'stun:stun.cloudflare.com:3478' }],
    ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}),
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
  let recoveryAttempts = 0;
  let recoveryExhausted = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionState: DuplexConnectionState = 'idle';
  const listeners = new Set<PeerEventListener>();
  const remoteTracks = new Map<string, MediaStreamTrack>();
  const isConnected = (): boolean =>
    connection.connectionState === 'connected' &&
    (connection.iceConnectionState === 'connected' ||
      connection.iceConnectionState === 'completed');
  const dataChannels = new Map<DuplexOwnedDataChannelLabel, DuplexDataChannel>();
  const attachDataChannel = (raw: RTCDataChannel): void => {
    if (
      raw.label !== DATA_CHANNEL_LABELS.fileTransfer &&
      raw.label !== DATA_CHANNEL_LABELS.collaboration &&
      raw.label !== DATA_CHANNEL_LABELS.pointer &&
      raw.label !== DATA_CHANNEL_LABELS.control &&
      raw.label !== DATA_CHANNEL_LABELS.input
    ) {
      raw.close();
      return;
    }
    const label = raw.label;
    if (dataChannels.has(label)) {
      raw.close();
      return;
    }
    const channel = createDuplexDataChannel(raw);
    dataChannels.set(label, channel);
    emit({ type: 'data-channel', channel });
    channel.subscribe((event) => {
      if (event.type === 'open') {
        emit({ type: 'data-channel-open', label });
      }
      if (event.type === 'close' && dataChannels.get(label) === channel) dataChannels.delete(label);
    });
  };
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
  if (!options.polite) {
    attachDataChannel(
      connection.createDataChannel(DATA_CHANNEL_LABELS.fileTransfer, { ordered: true }),
    );
    attachDataChannel(
      connection.createDataChannel(DATA_CHANNEL_LABELS.collaboration, { ordered: true }),
    );
    attachDataChannel(
      connection.createDataChannel(DATA_CHANNEL_LABELS.pointer, {
        ordered: false,
        maxRetransmits: 0,
      }),
    );
    attachDataChannel(connection.createDataChannel(DATA_CHANNEL_LABELS.control, { ordered: true }));
    // Button down/up, drag and scroll must neither be lost nor reordered; motion is coalesced above.
    attachDataChannel(connection.createDataChannel(DATA_CHANNEL_LABELS.input, { ordered: true }));
  }
  connection.ondatachannel = (event) => {
    attachDataChannel(event.channel);
  };
  const emitState = (): void => {
    if (isConnected()) {
      hasConnected = true;
      recoveryAttempts = 0;
      recoveryExhausted = false;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      if (recoveryCheckTimer) clearTimeout(recoveryCheckTimer);
      recoveryTimer = null;
      recoveryCheckTimer = null;
      void inspectConnectionPath();
    } else if (recoveryExhausted) {
      connectionState = 'failed';
      emit({ type: 'connection-state', state: 'failed' });
      return;
    } else if (
      hasConnected &&
      (connection.connectionState === 'disconnected' ||
        connection.connectionState === 'failed' ||
        connection.iceConnectionState === 'disconnected' ||
        connection.iceConnectionState === 'failed')
    ) {
      scheduleIceRecovery();
    } else if (
      connection.connectionState === 'failed' ||
      connection.iceConnectionState === 'failed'
    ) {
      scheduleIceRecovery();
    }
    const recoveryPending =
      recoveryTimer !== null || recoveryCheckTimer !== null || recoveryAttempts > 0;
    connectionState = recoveryPending
      ? hasConnected
        ? 'reconnecting'
        : 'connecting'
      : deriveConnectionState({
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
          hasConnected,
        });
    emit({ type: 'connection-state', state: connectionState });
  };
  const emitConnectionPath = (path: ConnectionPath): void => {
    emit({ type: 'connection-path', path });
  };
  const inspectConnectionPath = async (): Promise<void> => {
    try {
      const stats = await connection.getStats();
      let selectedLocalCandidateId: string | undefined;
      for (const id of stats.keys()) {
        const report: unknown = stats.get(id);
        if (typeof report !== 'object' || report === null) continue;
        const fields = report as Record<string, unknown>;
        if (
          fields['type'] === 'candidate-pair' &&
          fields['state'] === 'succeeded' &&
          (fields['selected'] === true || fields['nominated'] === true) &&
          typeof fields['localCandidateId'] === 'string'
        ) {
          selectedLocalCandidateId = fields['localCandidateId'];
          break;
        }
      }
      const localCandidate: unknown = selectedLocalCandidateId
        ? stats.get(selectedLocalCandidateId)
        : undefined;
      let candidateType: string | undefined;
      if (typeof localCandidate === 'object' && localCandidate !== null) {
        const fields = localCandidate as Record<string, unknown>;
        if (fields['type'] === 'local-candidate' && typeof fields['candidateType'] === 'string')
          candidateType = fields['candidateType'];
      }
      emitConnectionPath(
        candidateType === 'relay' ? 'relay' : candidateType ? 'direct' : 'unknown',
      );
    } catch {
      emitConnectionPath('unknown');
    }
  };
  const scheduleIceRecovery = (): void => {
    if (recoveryTimer || recoveryCheckTimer || recoveryAttempts >= 2 || closed) {
      if (recoveryAttempts >= 2 && !recoveryCheckTimer) emitFailure();
      return;
    }
    recoveryTimer = setTimeout(
      () => {
        recoveryTimer = null;
        if (isConnected() || closed) return;
        recoveryAttempts += 1;
        connection.restartIce();
        recoveryCheckTimer = setTimeout(() => {
          recoveryCheckTimer = null;
          if (isConnected()) return;
          if (recoveryAttempts < 2) scheduleIceRecovery();
          else emitFailure();
        }, 8000);
      },
      recoveryAttempts === 0 ? 2500 : 0,
    );
  };
  const emitFailure = (): void => {
    if (recoveryExhausted) return;
    recoveryExhausted = true;
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
    // The impolite peer owns initial offer creation. Waiting for that offer prevents both
    // participants from racing an initial offer while the polite peer is being set up.
    if (options.polite && !connection.remoteDescription) return;
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
    updateIceServers(iceServers): void {
      connection.setConfiguration({ ...connection.getConfiguration(), iceServers });
    },
    restartIce(): void {
      connection.restartIce();
    },
    setVideoTrack(track): Promise<void> {
      return videoSender.replaceTrack(track);
    },
    subscribe(listener: PeerEventListener): () => void {
      listeners.add(listener);
      for (const channel of dataChannels.values()) {
        listener({ type: 'data-channel', channel });
        if (channel.state === 'open') listener({ type: 'data-channel-open', label: channel.label });
      }
      return () => listeners.delete(listener);
    },
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      connection.onnegotiationneeded = null;
      connection.onicecandidate = null;
      connection.ontrack = null;
      connection.ondatachannel = null;
      connection.onconnectionstatechange = null;
      connection.oniceconnectionstatechange = null;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      if (recoveryCheckTimer) clearTimeout(recoveryCheckTimer);
      recoveryTimer = null;
      recoveryCheckTimer = null;
      for (const channel of dataChannels.values()) channel.close();
      dataChannels.clear();
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
