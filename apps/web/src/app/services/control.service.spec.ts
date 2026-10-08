import { describe, expect, it, vi } from 'vitest';
import { ControlService } from './control.service';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';

class FakeChannel implements DuplexDataChannel {
  readonly label = 'duplex-control' as const;
  state: DuplexDataChannel['state'] = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];
  private listeners = new Set<(event: DuplexDataChannelEvent) => void>();
  open(): void {
    this.state = 'open';
    for (const listener of this.listeners) listener({ type: 'open' });
  }
  receive(value: unknown): void {
    for (const listener of this.listeners)
      listener({ type: 'message', data: JSON.stringify(value) });
  }
  sendText(value: string): void {
    this.sent.push(value);
  }
  sendBinary(): void {
    throw new Error('Not used');
  }
  waitForBufferedAmountLow(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(listener: (event: DuplexDataChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.state = 'closed';
    for (const listener of this.listeners) listener({ type: 'close' });
  }
}

describe('ControlService', () => {
  it('requests only when peer screen and helper capability are current', () => {
    const service = new ControlService();
    const channel = new FakeChannel();
    const peerSurface = crypto.randomUUID();
    service.attachChannel(channel);
    service.setPeerMedia('screen', peerSurface);
    expect(service.canRequest()).toBe(false);
    channel.open();
    channel.receive({
      type: 'control-capability',
      protocolVersion: 1,
      surfaceId: peerSurface,
      helperConnected: true,
    });
    expect(service.canRequest()).toBe(true);
    service.requestControl(['pointer']);
    const request = JSON.parse(channel.sent.at(-1) ?? '{}') as { type: string; scopes: string[] };
    expect(request.type).toBe('control-request');
    expect(request.scopes).toEqual(['pointer']);
    expect(service.state()).toBe('requesting');
    service.peerChanged();
    expect(service.state()).toBe('idle');
    vi.clearAllTimers();
  });

  it('requires matching active local screen and helper before granting, then expires and revokes helper state', () => {
    vi.useFakeTimers();
    const service = new ControlService();
    const channel = new FakeChannel();
    const hostSurface = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const helperChange = vi.fn();
    service.setHelperSessionListener(helperChange);
    service.attachChannel(channel);
    channel.open();
    service.setLocalScreen(hostSurface);
    service.setHelperConnected(true);
    channel.receive({
      type: 'control-request',
      protocolVersion: 1,
      surfaceId: crypto.randomUUID(),
      requestId,
      scopes: ['pointer'],
    });
    expect(service.incomingRequest()).toBeNull();
    expect(JSON.parse(channel.sent.at(-1) ?? '{}')).toMatchObject({
      type: 'control-rejected',
      requestId,
    });

    channel.receive({
      type: 'control-request',
      protocolVersion: 1,
      surfaceId: hostSurface,
      requestId,
      scopes: ['pointer', 'keyboard'],
    });
    expect(service.state()).toBe('incoming-request');
    service.allow(['pointer']);
    expect(service.state()).toBe('being-controlled');
    expect(service.session()?.scopes).toEqual(['pointer']);
    expect(service.session()?.expiresAt).toBe(Date.now() + 10 * 60 * 1000);
    expect(helperChange).toHaveBeenCalledWith(service.session());
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(service.session()).toBeNull();
    expect(service.state()).toBe('revoked');
    expect(helperChange.mock.calls.at(-1)?.[0]).toBeNull();
    expect(JSON.parse(channel.sent.at(-1) ?? '{}')).toMatchObject({
      type: 'control-revoked',
      reason: 'expired',
    });
    vi.useRealTimers();
  });

  it('ignores stale surfaces and grants broader than the original request', () => {
    const service = new ControlService();
    const channel = new FakeChannel();
    const surfaceId = crypto.randomUUID();
    service.attachChannel(channel);
    channel.open();
    service.setPeerMedia('screen', surfaceId);
    channel.receive({
      type: 'control-capability',
      protocolVersion: 1,
      surfaceId,
      helperConnected: true,
    });
    service.requestControl(['pointer']);
    const request = JSON.parse(channel.sent.at(-1) ?? '{}') as { requestId: string };
    channel.receive({
      type: 'control-granted',
      protocolVersion: 1,
      surfaceId,
      requestId: request.requestId,
      controlSessionId: crypto.randomUUID(),
      scopes: ['pointer', 'keyboard'],
      expiresAt: Date.now() + 1000,
    });
    expect(service.session()).toBeNull();
    expect(service.state()).toBe('requesting');
    channel.receive({
      type: 'control-capability',
      protocolVersion: 1,
      surfaceId: crypto.randomUUID(),
      helperConnected: true,
    });
    expect(service.canRequest()).toBe(true);
    vi.clearAllTimers();
  });

  it('revokes on surface end, helper disconnect, peer replacement, and channel close', () => {
    vi.useFakeTimers();
    const service = new ControlService();
    const channel = new FakeChannel();
    const surfaceId = crypto.randomUUID();
    const helperEvents: unknown[][] = [];
    service.setHelperSessionListener((...event) => helperEvents.push(event));
    service.attachChannel(channel);
    channel.open();
    service.setLocalScreen(surfaceId);
    service.setHelperConnected(true);

    const grant = (requestId: string): void => {
      channel.receive({
        type: 'control-request',
        protocolVersion: 1,
        surfaceId,
        requestId,
        scopes: ['pointer'],
      });
      service.allow();
      expect(service.session()).not.toBeNull();
    };
    grant(crypto.randomUUID());
    service.setLocalScreen(null);
    expect(service.session()).toBeNull();
    expect(JSON.parse(channel.sent.at(-1) ?? '{}')).toMatchObject({
      type: 'control-revoked',
      reason: 'surface-ended',
    });

    service.setLocalScreen(surfaceId);
    grant(crypto.randomUUID());
    service.setHelperConnected(false);
    expect(service.session()).toBeNull();
    expect(JSON.parse(channel.sent.at(-1) ?? '{}')).toMatchObject({
      type: 'control-revoked',
      reason: 'helper-disconnected',
    });

    service.setHelperConnected(true);
    grant(crypto.randomUUID());
    channel.close();
    expect(service.session()).toBeNull();
    expect(helperEvents.at(-1)?.[0]).toBeNull();
    vi.useRealTimers();
  });

  it('expires an unanswered request instead of leaving the consent surface open forever', () => {
    vi.useFakeTimers();
    const service = new ControlService();
    const channel = new FakeChannel();
    const surfaceId = crypto.randomUUID();
    service.attachChannel(channel);
    channel.open();
    service.setLocalScreen(surfaceId);
    service.setHelperConnected(true);
    channel.receive({
      type: 'control-request',
      protocolVersion: 1,
      surfaceId,
      requestId: crypto.randomUUID(),
      scopes: ['pointer'],
    });
    expect(service.incomingRequest()).not.toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(service.incomingRequest()).toBeNull();
    expect(service.state()).toBe('revoked');
    vi.useRealTimers();
  });

  it('expires an unanswered outgoing request and allows a fresh request afterward', () => {
    vi.useFakeTimers();
    const service = new ControlService();
    const channel = new FakeChannel();
    const surfaceId = crypto.randomUUID();
    service.attachChannel(channel);
    channel.open();
    service.setPeerMedia('screen', surfaceId);
    channel.receive({
      type: 'control-capability',
      protocolVersion: 1,
      surfaceId,
      helperConnected: true,
    });
    service.requestControl(['pointer']);
    const originalRequestCount = channel.sent.length;
    service.requestControl(['keyboard']);
    expect(channel.sent).toHaveLength(originalRequestCount);
    vi.advanceTimersByTime(30_000);
    expect(service.state()).toBe('revoked');
    service.requestControl(['keyboard']);
    expect(channel.sent).toHaveLength(originalRequestCount + 1);
    vi.useRealTimers();
  });
});
