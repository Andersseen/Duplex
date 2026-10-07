import type { DuplexConnectionState } from './connection-state';
import type { AnswerMessage, IceCandidateMessage, OfferMessage } from '@duplex/protocol';
import type { RtcConfigMessage } from '@duplex/protocol';

/** Labels of the RTC data channels Duplex will open. Fixed so both peers agree. */
export const DATA_CHANNEL_LABELS = {
  /** Control negotiation relayed peer to peer once remote control exists. */
  control: 'duplex-control',
} as const;

export type DataChannelLabel = (typeof DATA_CHANNEL_LABELS)[keyof typeof DATA_CHANNEL_LABELS];

export interface RemoteMedia {
  readonly audio: MediaStream | null;
  /** The single active remote video source; Duplex does not infer camera vs screen. */
  readonly video: MediaStream | null;
}

export type ConnectionPath = 'direct' | 'relay' | 'unknown';

export type PeerEvent =
  | { readonly type: 'connection-state'; readonly state: DuplexConnectionState }
  | { readonly type: 'remote-media'; readonly media: RemoteMedia }
  | { readonly type: 'connection-path'; readonly path: ConnectionPath }
  | { readonly type: 'data-channel-open'; readonly label: DataChannelLabel };

export type PeerEventListener = (event: PeerEvent) => void;

export type PeerSignalingMessage = OfferMessage | AnswerMessage | IceCandidateMessage;

export interface SignalingTransport {
  send(message: PeerSignalingMessage): void;
  subscribe(listener: (message: PeerSignalingMessage) => void): () => void;
}

/**
 * Public contract of a Duplex 1:1 peer.
 */
export interface DuplexPeer {
  readonly connectionState: DuplexConnectionState;
  updateIceServers(iceServers: RTCIceServer[]): void;
  restartIce(): void;
  setVideoTrack(track: MediaStreamTrack | null): Promise<void>;
  subscribe(listener: PeerEventListener): () => void;
  close(): void;
}

export function toRtcIceServers(
  iceServers: RtcConfigMessage['payload']['iceServers'],
): RTCIceServer[] {
  return iceServers.map((server) => ({
    urls: server.urls,
    ...(server.username ? { username: server.username } : {}),
    ...(server.credential ? { credential: server.credential } : {}),
  }));
}
