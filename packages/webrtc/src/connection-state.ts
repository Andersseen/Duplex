/**
 * What the UI cares about, derived from the several overlapping browser states.
 * Kept small on purpose: the UI should never have to reason about ICE vs peer state.
 */
export type DuplexConnectionState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface RawConnectionStates {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  /** True once the connection has reached `connected` at least once. */
  readonly hasConnected: boolean;
}

export function deriveConnectionState(raw: RawConnectionStates): DuplexConnectionState {
  switch (raw.connectionState) {
    case 'closed':
      return 'closed';
    case 'failed':
      return 'failed';
    case 'connected':
      return 'connected';
    case 'disconnected':
      return raw.hasConnected ? 'reconnecting' : 'connecting';
    case 'connecting':
      return raw.hasConnected ? 'reconnecting' : 'connecting';
    case 'new':
      return raw.iceConnectionState === 'new' ? 'idle' : 'connecting';
  }
}
