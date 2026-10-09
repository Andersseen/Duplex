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

/** A paired helper that can execute pointer control for a monitor share. */
function readyHelper(service: ControlService, surfaceId: string): void {
  service.setLocalScreen(surfaceId, true);
  service.setHelperConnected(true);
  service.setHelperScopes(['pointer']);
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
      availableScopes: ['pointer'],
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
    readyHelper(service, hostSurface);
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
      scopes: ['pointer'],
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
      availableScopes: ['pointer'],
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
      availableScopes: ['pointer'],
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
    readyHelper(service, surfaceId);

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

    readyHelper(service, surfaceId);
    grant(crypto.randomUUID());
    service.setHelperConnected(false);
    expect(service.session()).toBeNull();
    expect(JSON.parse(channel.sent.at(-1) ?? '{}')).toMatchObject({
      type: 'control-revoked',
      reason: 'helper-disconnected',
    });

    readyHelper(service, surfaceId);
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
    readyHelper(service, surfaceId);
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
      availableScopes: ['pointer'],
    });
    service.requestControl(['pointer']);
    const originalRequestCount = channel.sent.length;
    service.requestControl(['pointer']);
    expect(channel.sent).toHaveLength(originalRequestCount);
    vi.advanceTimersByTime(30_000);
    expect(service.state()).toBe('revoked');
    service.requestControl(['pointer']);
    expect(channel.sent).toHaveLength(originalRequestCount + 1);
    vi.useRealTimers();
  });

  describe('available scopes', () => {
    function setup(): { service: ControlService; channel: FakeChannel; surfaceId: string } {
      const service = new ControlService();
      const channel = new FakeChannel();
      service.attachChannel(channel);
      channel.open();
      return { service, channel, surfaceId: crypto.randomUUID() };
    }
    const lastSent = (channel: FakeChannel): Record<string, unknown> =>
      JSON.parse(channel.sent.at(-1) ?? '{}') as Record<string, unknown>;

    it('announces only what the helper reports, and only for a monitor share', () => {
      const { service, channel, surfaceId } = setup();
      service.setLocalScreen(surfaceId, false);
      service.setHelperConnected(true);
      service.setHelperScopes(['pointer']);
      expect(lastSent(channel)).toMatchObject({ helperConnected: true, availableScopes: [] });
      service.setLocalScreen(surfaceId, true);
      expect(lastSent(channel)).toMatchObject({ availableScopes: ['pointer'] });
      service.setHelperScopes([]);
      expect(lastSent(channel)).toMatchObject({ helperConnected: true, availableScopes: [] });
    });

    it('never advertises keyboard even if a helper reports it', () => {
      const { service, channel, surfaceId } = setup();
      service.setLocalScreen(surfaceId, true);
      service.setHelperConnected(true);
      service.setHelperScopes(['pointer', 'keyboard']);
      expect(lastSent(channel)).toMatchObject({ availableScopes: ['pointer'] });
      expect(service.localAvailableScopes()).toEqual(['pointer']);
    });

    it('clears helper scopes when the helper disconnects', () => {
      const { service, channel, surfaceId } = setup();
      readyHelper(service, surfaceId);
      service.setHelperConnected(false);
      expect(service.localAvailableScopes()).toEqual([]);
      expect(lastSent(channel)).toMatchObject({ helperConnected: false, availableScopes: [] });
    });

    it('rejects requests for scopes the helper cannot execute and never grants them', () => {
      const { service, channel, surfaceId } = setup();
      readyHelper(service, surfaceId);
      const requestId = crypto.randomUUID();
      channel.receive({
        type: 'control-request',
        protocolVersion: 1,
        surfaceId,
        requestId,
        scopes: ['pointer', 'keyboard'],
      });
      expect(service.incomingRequest()).toBeNull();
      expect(lastSent(channel)).toMatchObject({ type: 'control-rejected', requestId });
      // Without a monitor share nothing is executable, so even a pointer request is refused.
      service.setLocalScreen(surfaceId, false);
      channel.receive({
        type: 'control-request',
        protocolVersion: 1,
        surfaceId,
        requestId: crypto.randomUUID(),
        scopes: ['pointer'],
      });
      expect(service.incomingRequest()).toBeNull();
      expect(service.session()).toBeNull();
    });

    it('does not let the controller request an unadvertised scope or request with no capability', () => {
      const { service, channel, surfaceId } = setup();
      service.setPeerMedia('screen', surfaceId);
      channel.receive({
        type: 'control-capability',
        protocolVersion: 1,
        surfaceId,
        helperConnected: true,
        availableScopes: [],
      });
      expect(service.canRequest()).toBe(false);
      channel.receive({
        type: 'control-capability',
        protocolVersion: 1,
        surfaceId,
        helperConnected: true,
        availableScopes: ['pointer'],
      });
      expect(service.canRequest()).toBe(true);
      const sent = channel.sent.length;
      service.requestControl(['keyboard']);
      service.requestControl(['pointer', 'keyboard']);
      expect(channel.sent).toHaveLength(sent);
      service.requestControl();
      expect(lastSent(channel)).toMatchObject({ type: 'control-request', scopes: ['pointer'] });
      vi.clearAllTimers();
    });

    it('revokes an active grant when the helper loses the pointer capability', () => {
      vi.useFakeTimers();
      const { service, channel, surfaceId } = setup();
      const helperEvents: unknown[][] = [];
      service.setHelperSessionListener((...event) => helperEvents.push(event));
      readyHelper(service, surfaceId);
      channel.receive({
        type: 'control-request',
        protocolVersion: 1,
        surfaceId,
        requestId: crypto.randomUUID(),
        scopes: ['pointer'],
      });
      service.allow();
      expect(service.session()).not.toBeNull();
      service.setHelperScopes([]);
      expect(service.session()).toBeNull();
      expect(lastSent(channel)).toMatchObject({
        type: 'control-revoked',
        reason: 'capability-lost',
      });
      expect(helperEvents.at(-1)?.[0]).toBeNull();
      vi.useRealTimers();
    });

    it('stops controlling when the peer announces it lost the capability', () => {
      vi.useFakeTimers();
      const { service, channel, surfaceId } = setup();
      service.setPeerMedia('screen', surfaceId);
      const capability = (availableScopes: string[]): void => {
        channel.receive({
          type: 'control-capability',
          protocolVersion: 1,
          surfaceId,
          helperConnected: true,
          availableScopes,
        });
      };
      capability(['pointer']);
      service.requestControl(['pointer']);
      const request = lastSent(channel) as { requestId: string };
      channel.receive({
        type: 'control-granted',
        protocolVersion: 1,
        surfaceId,
        requestId: request.requestId,
        controlSessionId: crypto.randomUUID(),
        scopes: ['pointer'],
        expiresAt: Date.now() + 60_000,
      });
      expect(service.state()).toBe('controlling');
      capability([]);
      expect(service.session()).toBeNull();
      expect(service.canRequest()).toBe(false);
      vi.useRealTimers();
    });

    it('notifies observers before a session ends so held input can be released', () => {
      vi.useFakeTimers();
      const { service, channel, surfaceId } = setup();
      readyHelper(service, surfaceId);
      const events: string[] = [];
      service.addSessionObserver((event, session) => {
        events.push(
          `${event}:${String(service.session()?.controlSessionId === session.controlSessionId)}`,
        );
      });
      channel.receive({
        type: 'control-request',
        protocolVersion: 1,
        surfaceId,
        requestId: crypto.randomUUID(),
        scopes: ['pointer'],
      });
      service.allow();
      service.release();
      expect(events[0]).toBe('started:true');
      // The session is still current when 'ending' fires.
      expect(events[1]).toBe('ending:true');
      vi.useRealTimers();
    });
  });
});
