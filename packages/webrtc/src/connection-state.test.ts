import { describe, expect, it } from 'vitest';
import { deriveConnectionState } from './index';

describe('deriveConnectionState', () => {
  it('is idle for a fresh connection', () => {
    expect(
      deriveConnectionState({
        connectionState: 'new',
        iceConnectionState: 'new',
        hasConnected: false,
      }),
    ).toBe('idle');
  });

  it('is connecting while negotiating for the first time', () => {
    expect(
      deriveConnectionState({
        connectionState: 'connecting',
        iceConnectionState: 'checking',
        hasConnected: false,
      }),
    ).toBe('connecting');
  });

  it('reports reconnecting only after a connection was established', () => {
    const disconnected = {
      connectionState: 'disconnected',
      iceConnectionState: 'disconnected',
    } as const;
    expect(deriveConnectionState({ ...disconnected, hasConnected: true })).toBe('reconnecting');
    expect(deriveConnectionState({ ...disconnected, hasConnected: false })).toBe('connecting');
  });

  it('keeps an established peer in recovery while either browser state is failed or disconnected', () => {
    expect(
      deriveConnectionState({
        connectionState: 'failed',
        iceConnectionState: 'failed',
        hasConnected: true,
      }),
    ).toBe('reconnecting');
    expect(
      deriveConnectionState({
        connectionState: 'connected',
        iceConnectionState: 'disconnected',
        hasConnected: true,
      }),
    ).toBe('reconnecting');
  });

  it('passes through terminal and connected states', () => {
    const base = { iceConnectionState: 'connected', hasConnected: true } as const;
    expect(deriveConnectionState({ ...base, connectionState: 'connected' })).toBe('connected');
    expect(deriveConnectionState({ ...base, connectionState: 'failed' })).toBe('reconnecting');
    expect(deriveConnectionState({ ...base, connectionState: 'closed' })).toBe('closed');
  });
});
