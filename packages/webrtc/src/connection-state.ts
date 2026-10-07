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
  if (raw.connectionState === 'closed') return 'closed';
  if (
    raw.hasConnected &&
    (raw.connectionState === 'disconnected' ||
      raw.connectionState === 'connecting' ||
      raw.connectionState === 'failed' ||
      raw.iceConnectionState === 'disconnected' ||
      raw.iceConnectionState === 'checking' ||
      raw.iceConnectionState === 'failed')
  )
    return 'reconnecting';
  switch (raw.connectionState) {
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
