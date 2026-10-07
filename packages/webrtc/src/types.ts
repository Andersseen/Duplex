import type { DuplexConnectionState } from './connection-state';
import type { AnswerMessage, IceCandidateMessage, OfferMessage } from '@duplex/protocol';

/** Labels of the RTC data channels Duplex will open. Fixed so both peers agree. */
export const DATA_CHANNEL_LABELS = {
  /** Control negotiation relayed peer to peer once remote control exists. */
  control: 'duplex-control',
} as const;

export type DataChannelLabel = (typeof DATA_CHANNEL_LABELS)[keyof typeof DATA_CHANNEL_LABELS];

/** Which kind of video a remote track carries. Screen share is distinct from camera. */
export type VideoSource = 'camera' | 'screen';

export interface LocalMedia {
  readonly audio: MediaStream | null;
  readonly camera: MediaStream | null;
  readonly screen: MediaStream | null;
}

export interface RemoteMedia {
  readonly audio: MediaStream | null;
  readonly camera: MediaStream | null;
  readonly screen: MediaStream | null;
}

export type PeerEvent =
  | { readonly type: 'connection-state'; readonly state: DuplexConnectionState }
  | { readonly type: 'remote-media'; readonly media: RemoteMedia }
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
  subscribe(listener: PeerEventListener): () => void;
  close(): void;
}
