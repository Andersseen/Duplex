import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import {
  CLIPBOARD_APPROVAL_TIMEOUT_MS,
  CLIPBOARD_MIN_INTERVAL_MS,
  CLIPBOARD_OPERATION_TIMEOUT_MS,
  CLIPBOARD_PROTOCOL_VERSION,
  MAX_CLIPBOARD_TEXT_BYTES,
} from '@duplex/protocol';
import type { ClipboardMessage, ControlScope } from '@duplex/protocol';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';
import { ClipboardService } from './clipboard.service';
import type { ClipboardApi } from './clipboard.service';
import type { ActiveControlSession, ControlService, ControlSessionEvent } from './control.service';

class FakeChannel implements DuplexDataChannel {
  readonly label = 'duplex-input' as const;
  state: DuplexDataChannel['state'] = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];
  private listeners = new Set<(event: DuplexDataChannelEvent) => void>();
  receive(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    for (const listener of this.listeners) listener({ type: 'message', data });
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
    if (this.state === 'open') listener({ type: 'open' });
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.state = 'closed';
    for (const listener of this.listeners) listener({ type: 'close' });
  }
  messages(): ClipboardMessage[] {
    return this.sent.map((value) => JSON.parse(value) as ClipboardMessage);
  }
}

const SESSION_ID = crypto.randomUUID();
const SURFACE_ID = crypto.randomUUID();

/** Just the slice of ControlService the clipboard service reads, driven directly by tests. */
function fakeControl() {
  const observers = new Set<(event: ControlSessionEvent, session: ActiveControlSession) => void>();
  const control = {
    session: signal<ActiveControlSession | null>(null),
    peerAvailableScopes: signal<readonly ControlScope[]>(['clipboard']),
    peerSurfaceId: signal<string | null>(SURFACE_ID),
    localSurfaceId: signal<string | null>(SURFACE_ID),
    localAvailableScopes: signal<readonly ControlScope[]>(['clipboard']),
    helperConnected: signal(true),
    addSessionObserver: (
      observer: (event: ControlSessionEvent, s: ActiveControlSession) => void,
    ) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
  return {
    control,
    start: (role: 'controller' | 'controlled', scopes: readonly ControlScope[] = ['clipboard']) => {
      const session: ActiveControlSession = {
        requestId: crypto.randomUUID(),
        controlSessionId: SESSION_ID,
        surfaceId: SURFACE_ID,
        scopes,
        expiresAt: Date.now() + 60_000,
        role,
      };
      control.session.set(session);
      for (const observer of observers) observer('started', session);
      return session;
    },
    end: () => {
      const session = control.session();
      if (session) for (const observer of observers) observer('ending', session);
      control.session.set(null);
    },
  };
}

function build(api: ClipboardApi = {}) {
  const rig = fakeControl();
  const service = new ClipboardService(rig.control as unknown as ControlService, api);
  const channel = new FakeChannel();
  service.attachChannel(channel);
  const relayed: unknown[] = [];
  service.setHelperRelay((message) => {
    relayed.push(message);
    return true;
  });
  return { ...rig, service, channel, relayed };
}

let sequence = 0;
function inbound(extra: Record<string, unknown>) {
  return {
    protocolVersion: CLIPBOARD_PROTOCOL_VERSION,
    controlSessionId: SESSION_ID,
    surfaceId: SURFACE_ID,
    sequence: ++sequence,
    transferId: crypto.randomUUID(),
    ...extra,
  };
}

beforeEach(() => {
  sequence = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ClipboardService (controller)', () => {
  const api = (text: string, allowed = true): ClipboardApi => ({
    readText: vi.fn(() => (allowed ? Promise.resolve(text) : Promise.reject(new Error('denied')))),
    writeText: vi.fn(() => Promise.resolve()),
  });

  it('offers the clipboard only with an authorized clipboard grant, an open channel and peer capability', () => {
    const { service, control, start } = build(api('x'));
    expect(service.available()).toBe(false);
    start('controller', ['pointer', 'keyboard']);
    expect(service.available()).toBe(false);
    start('controller');
    expect(service.available()).toBe(true);
    control.peerAvailableScopes.set(['pointer']);
    expect(service.available()).toBe(false);
    control.peerAvailableScopes.set(['clipboard']);
    control.peerSurfaceId.set(crypto.randomUUID());
    expect(service.available()).toBe(false);
  });

  it('is not available when this side is the controlled one', () => {
    const { service, start } = build(api('x'));
    start('controlled');
    expect(service.available()).toBe(false);
  });

  it('reads the clipboard only when asked, sends a typed bounded message and reports delivery', async () => {
    const clipboard = api('hello remote');
    const { service, channel, start } = build(clipboard);
    start('controller');
    expect(clipboard.readText).not.toHaveBeenCalled();

    await service.sendLocalClipboard();
    const [message] = channel.messages();
    expect(clipboard.readText).toHaveBeenCalledOnce();
    expect(message).toMatchObject({
      type: 'clipboard-write',
      controlSessionId: SESSION_ID,
      surfaceId: SURFACE_ID,
      text: 'hello remote',
      sequence: 1,
    });
    expect(service.busy()).toBe(true);

    channel.receive(
      inbound({ type: 'clipboard-status', transferId: message?.transferId, outcome: 'delivered' }),
    );
    expect(service.busy()).toBe(false);
    expect(service.notice()?.text).toContain('Sent 12 characters');
  });

  it('refuses a second operation while one is pending', async () => {
    const clipboard = api('one');
    const { service, channel, start } = build(clipboard);
    start('controller');
    await service.sendLocalClipboard();
    await service.sendLocalClipboard();
    service.requestRemoteClipboard();
    expect(channel.sent).toHaveLength(1);
  });

  it('does nothing without a grant, and never reads the clipboard for a pointer-only grant', async () => {
    const clipboard = api('secret');
    const { service, channel, start } = build(clipboard);
    await service.sendLocalClipboard();
    start('controller', ['pointer']);
    await service.sendLocalClipboard();
    service.requestRemoteClipboard();
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
  });

  it('explains a browser permission denial and sends nothing', async () => {
    const { service, channel, start } = build(api('x', false));
    start('controller');
    await service.sendLocalClipboard();
    expect(channel.sent).toEqual([]);
    expect(service.notice()).toMatchObject({ tone: 'error' });
    expect(service.notice()?.text).toMatch(/did not allow reading your clipboard/);
    expect(service.busy()).toBe(false);
  });

  it('reports an unsupported browser instead of failing silently', async () => {
    const { service, channel, start } = build({});
    start('controller');
    expect(service.canReadLocal()).toBe(false);
    expect(service.canWriteLocal()).toBe(false);
    await service.sendLocalClipboard();
    expect(service.notice()?.text).toMatch(/cannot read the clipboard/);
    service.requestRemoteClipboard();
    expect(service.notice()?.text).toMatch(/cannot write to your clipboard/);
    expect(channel.sent).toEqual([]);
  });

  it('rejects empty, oversized and unsupported text locally without sending it', async () => {
    for (const [text, pattern] of [
      ['', /no text/],
      ['x'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1), /KiB limit/],
      ['bad\u0000text', /cannot be sent/],
    ] as const) {
      const { service, channel, start } = build(api(text));
      start('controller');
      await service.sendLocalClipboard();
      expect(channel.sent).toEqual([]);
      expect(service.notice()?.text).toMatch(pattern);
    }
  });

  it('drops the send when the grant ends while the browser permission prompt is open', async () => {
    let resolve: (text: string) => void = () => undefined;
    const clipboard: ClipboardApi = {
      readText: () => new Promise<string>((done) => (resolve = done)),
    };
    const { service, channel, start, end } = build(clipboard);
    start('controller');
    const sending = service.sendLocalClipboard();
    end();
    resolve('too late');
    await sending;
    expect(channel.sent).toEqual([]);
  });

  it.each([
    ['declined', /declined/],
    ['unavailable', /not available/],
    ['empty', /no text/],
    ['too-large', /limit/],
    ['denied', /refused/],
    ['busy', /busy/],
    ['failed', /failed/],
  ] as const)('shows an accurate message for a %s outcome', async (outcome, pattern) => {
    const { service, channel, start } = build(api('x'));
    start('controller');
    await service.sendLocalClipboard();
    channel.receive(
      inbound({ type: 'clipboard-status', transferId: channel.messages()[0]?.transferId, outcome }),
    );
    expect(service.notice()).toMatchObject({ tone: 'error' });
    expect(service.notice()?.text).toMatch(pattern);
  });

  it('times out an unanswered operation and unblocks the buttons', async () => {
    const { service, start } = build(api('x'));
    start('controller');
    await service.sendLocalClipboard();
    vi.advanceTimersByTime(CLIPBOARD_OPERATION_TIMEOUT_MS);
    expect(service.busy()).toBe(false);
    expect(service.notice()?.text).toMatch(/did not answer/);
  });

  it('holds received text in memory until the user copies it, then clears it', async () => {
    const clipboard = api('x');
    const { service, channel, start } = build(clipboard);
    start('controller');
    service.requestRemoteClipboard();
    const request = channel.messages()[0];
    expect(request).toMatchObject({ type: 'clipboard-read-request' });
    channel.receive(
      inbound({ type: 'clipboard-text', transferId: request?.transferId, text: 'from remote' }),
    );
    expect(service.receivedCharacters()).toBe(11);
    // Receiving never touches the local clipboard by itself.
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await service.copyReceived();
    expect(clipboard.writeText).toHaveBeenCalledWith('from remote');
    expect(service.receivedCharacters()).toBeNull();
    expect(service.notice()?.text).toBe('Copied to your clipboard.');
  });

  it('keeps received text for a retry when the browser denies the copy, and can discard it', async () => {
    const clipboard: ClipboardApi = { writeText: vi.fn(() => Promise.reject(new Error('no'))) };
    const { service, channel, start } = build(clipboard);
    start('controller');
    service.requestRemoteClipboard();
    channel.receive(
      inbound({
        type: 'clipboard-text',
        transferId: channel.messages()[0]?.transferId,
        text: 'abc',
      }),
    );
    await service.copyReceived();
    expect(service.receivedCharacters()).toBe(3);
    expect(service.notice()?.text).toMatch(/did not allow copying/);
    service.discardReceived();
    expect(service.receivedCharacters()).toBeNull();
  });

  it('clears received text and pending state when the grant ends or is revoked', () => {
    const { service, channel, start, end } = build(api('x'));
    start('controller');
    service.requestRemoteClipboard();
    channel.receive(
      inbound({
        type: 'clipboard-text',
        transferId: channel.messages()[0]?.transferId,
        text: 'abc',
      }),
    );
    expect(service.receivedCharacters()).toBe(3);
    end();
    expect(service.receivedCharacters()).toBeNull();
    expect(service.busy()).toBe(false);
    expect(service.notice()).toBeNull();
  });

  it('ignores unsolicited text, wrong-session or wrong-surface replies, stale sequences and duplicates', () => {
    const { service, channel, start } = build(api('x'));
    start('controller');
    // Unsolicited: nothing is pending.
    channel.receive(inbound({ type: 'clipboard-text', text: 'surprise' }));
    expect(service.receivedCharacters()).toBeNull();

    service.requestRemoteClipboard();
    const transferId = channel.messages()[0]?.transferId;
    channel.receive(
      inbound({
        type: 'clipboard-text',
        transferId,
        controlSessionId: crypto.randomUUID(),
        text: 'x',
      }),
    );
    channel.receive(
      inbound({ type: 'clipboard-text', transferId, surfaceId: crypto.randomUUID(), text: 'x' }),
    );
    channel.receive(
      inbound({ type: 'clipboard-text', transferId: crypto.randomUUID(), text: 'x' }),
    );
    // A role-inverted message (controller receiving a request) is ignored.
    channel.receive(inbound({ type: 'clipboard-read-request', transferId }));
    expect(service.receivedCharacters()).toBeNull();
    expect(service.busy()).toBe(true);

    const accepted = inbound({ type: 'clipboard-text', transferId, text: 'real' });
    channel.receive(accepted);
    expect(service.receivedCharacters()).toBe(4);
    service.discardReceived();
    // Replaying the accepted message changes nothing.
    channel.receive(accepted);
    expect(service.receivedCharacters()).toBeNull();
  });

  it('ignores malformed, oversized and non-text frames', () => {
    const { service, channel, start } = build(api('x'));
    start('controller');
    service.requestRemoteClipboard();
    const transferId = channel.messages()[0]?.transferId;
    channel.receive('not json');
    channel.receive(inbound({ type: 'clipboard-text', transferId, text: 'a', extra: true }));
    channel.receive(inbound({ type: 'clipboard-text', transferId, text: 'x'.repeat(20_000) }));
    channel.receive(inbound({ type: 'clipboard-text', transferId, text: 'bad\u0000' }));
    expect(service.receivedCharacters()).toBeNull();
    expect(service.busy()).toBe(true);
  });

  it('ends the operation when the channel closes', async () => {
    const { service, channel, start } = build(api('x'));
    start('controller');
    channel.close();
    expect(service.available()).toBe(false);
    await service.sendLocalClipboard();
    expect(channel.sent).toEqual([]);
  });
});

describe('ClipboardService (controlled)', () => {
  it('relays an authorized write to the helper, never to the page clipboard, and confirms without content', () => {
    const { service, channel, relayed, start } = build();
    start('controlled');
    const message = inbound({ type: 'clipboard-write', text: 'paste this' });
    channel.receive(message);
    expect(relayed).toEqual([
      {
        type: 'helper-clipboard-write',
        controlSessionId: SESSION_ID,
        surfaceId: SURFACE_ID,
        transferId: message.transferId,
        text: 'paste this',
      },
    ]);
    service.handleHelperResult({
      type: 'helper-clipboard-result',
      controlSessionId: SESSION_ID,
      transferId: message.transferId,
      outcome: 'ok',
    });
    expect(channel.messages()).toEqual([
      expect.objectContaining({
        type: 'clipboard-status',
        outcome: 'delivered',
        transferId: message.transferId,
      }),
    ]);
    expect(service.peerWrote()).toEqual({ characters: 10 });
    expect(channel.sent.join('')).not.toContain('paste this');
  });

  it.each([
    ['pointer-only grant', ['pointer'] as ControlScope[], undefined],
    ['helper without clipboard capability', ['clipboard'] as ControlScope[], 'no-capability'],
    ['helper disconnected', ['clipboard'] as ControlScope[], 'no-helper'],
    ['a different local screen', ['clipboard'] as ControlScope[], 'wrong-screen'],
  ])('relays nothing under %s', (_name, scopes, fault) => {
    const { channel, relayed, control, start } = build();
    start('controlled', scopes);
    if (fault === 'no-capability') control.localAvailableScopes.set(['pointer']);
    if (fault === 'no-helper') control.helperConnected.set(false);
    if (fault === 'wrong-screen') control.localSurfaceId.set(crypto.randomUUID());
    channel.receive(inbound({ type: 'clipboard-write', text: 'nope' }));
    channel.receive(inbound({ type: 'clipboard-read-request' }));
    expect(relayed).toEqual([]);
    expect(channel.sent).toEqual([]);
  });

  it('ignores expired sessions, wrong ids, stale sequences and duplicate deliveries', () => {
    const { channel, relayed, start, control } = build();
    const session = start('controlled');
    const fresh = inbound({ type: 'clipboard-write', text: 'once' });
    channel.receive(fresh);
    expect(relayed).toHaveLength(1);
    // Duplicate delivery of the same message.
    channel.receive(fresh);
    // Same transfer id with a newer sequence is still a duplicate transfer.
    channel.receive(
      inbound({ type: 'clipboard-write', transferId: fresh.transferId, text: 'again' }),
    );
    // An older sequence is stale.
    channel.receive({ ...inbound({ type: 'clipboard-write', text: 'old' }), sequence: 0 });
    channel.receive(
      inbound({ type: 'clipboard-write', text: 'x', controlSessionId: crypto.randomUUID() }),
    );
    channel.receive(
      inbound({ type: 'clipboard-write', text: 'x', surfaceId: crypto.randomUUID() }),
    );
    expect(relayed).toHaveLength(1);

    control.session.set({ ...session, expiresAt: Date.now() - 1 });
    vi.advanceTimersByTime(CLIPBOARD_MIN_INTERVAL_MS * 2);
    channel.receive(inbound({ type: 'clipboard-write', text: 'late' }));
    expect(relayed).toHaveLength(1);
  });

  it('answers busy to operations that arrive while one is in flight or too quickly', () => {
    const { channel, relayed, start } = build();
    start('controlled');
    channel.receive(inbound({ type: 'clipboard-write', text: 'first' }));
    const second = inbound({ type: 'clipboard-write', text: 'second' });
    channel.receive(second);
    expect(relayed).toHaveLength(1);
    expect(channel.messages().at(-1)).toMatchObject({
      type: 'clipboard-status',
      outcome: 'busy',
      transferId: second.transferId,
    });
  });

  it('requires approval for every read and only then asks the helper', () => {
    const { service, channel, relayed, start } = build();
    start('controlled');
    const request = inbound({ type: 'clipboard-read-request' });
    channel.receive(request);
    expect(service.incomingRead()).toEqual({ transferId: request.transferId });
    expect(relayed).toEqual([]);

    service.approveRead();
    expect(service.incomingRead()).toBeNull();
    expect(relayed).toEqual([
      {
        type: 'helper-clipboard-read',
        controlSessionId: SESSION_ID,
        surfaceId: SURFACE_ID,
        transferId: request.transferId,
      },
    ]);
    service.handleHelperResult({
      type: 'helper-clipboard-result',
      controlSessionId: SESSION_ID,
      transferId: request.transferId,
      outcome: 'ok',
      text: 'approved text',
    });
    expect(channel.messages().at(-1)).toMatchObject({
      type: 'clipboard-text',
      text: 'approved text',
      transferId: request.transferId,
    });
  });

  it('reports a declined read and never contacts the helper', () => {
    const { service, channel, relayed, start } = build();
    start('controlled');
    const request = inbound({ type: 'clipboard-read-request' });
    channel.receive(request);
    service.declineRead();
    expect(relayed).toEqual([]);
    expect(channel.messages().at(-1)).toMatchObject({
      type: 'clipboard-status',
      outcome: 'declined',
      transferId: request.transferId,
    });
  });

  it('declines a read nobody answered, and forgets it when the grant ends', () => {
    const { service, channel, relayed, start, end } = build();
    start('controlled');
    channel.receive(inbound({ type: 'clipboard-read-request' }));
    vi.advanceTimersByTime(CLIPBOARD_APPROVAL_TIMEOUT_MS);
    expect(service.incomingRead()).toBeNull();
    expect(channel.messages().at(-1)).toMatchObject({ outcome: 'declined' });

    vi.advanceTimersByTime(CLIPBOARD_MIN_INTERVAL_MS);
    channel.receive(inbound({ type: 'clipboard-read-request' }));
    expect(service.incomingRead()).not.toBeNull();
    end();
    expect(service.incomingRead()).toBeNull();
    service.approveRead();
    expect(relayed).toEqual([]);
  });

  it.each([
    ['denied', 'denied'],
    ['unavailable', 'unavailable'],
    ['empty', 'empty'],
    ['too-large', 'too-large'],
    ['failed', 'failed'],
  ] as const)('maps a helper %s result to the peer without any content', (helper, outcome) => {
    const { service, channel, start } = build();
    start('controlled');
    const request = inbound({ type: 'clipboard-read-request' });
    channel.receive(request);
    service.approveRead();
    service.handleHelperResult({
      type: 'helper-clipboard-result',
      controlSessionId: SESSION_ID,
      transferId: request.transferId,
      outcome: helper,
    });
    expect(channel.messages().at(-1)).toMatchObject({ type: 'clipboard-status', outcome });
  });

  it('tells the peer when the helper is unreachable or silent', () => {
    const { service, channel, start } = build();
    service.setHelperRelay(() => false);
    start('controlled');
    const write = inbound({ type: 'clipboard-write', text: 'x' });
    channel.receive(write);
    expect(channel.messages().at(-1)).toMatchObject({ outcome: 'unavailable' });

    service.setHelperRelay(() => true);
    vi.advanceTimersByTime(CLIPBOARD_MIN_INTERVAL_MS);
    channel.receive(inbound({ type: 'clipboard-write', text: 'y' }));
    vi.advanceTimersByTime(11_000);
    expect(channel.messages().at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('ignores helper results for unknown transfers, other sessions or ended grants', () => {
    const { service, channel, start, end } = build();
    start('controlled');
    const write = inbound({ type: 'clipboard-write', text: 'x' });
    channel.receive(write);
    const before = channel.sent.length;
    service.handleHelperResult({
      type: 'helper-clipboard-result',
      controlSessionId: SESSION_ID,
      transferId: crypto.randomUUID(),
      outcome: 'ok',
    });
    service.handleHelperResult({
      type: 'helper-clipboard-result',
      controlSessionId: crypto.randomUUID(),
      transferId: write.transferId,
      outcome: 'ok',
    });
    expect(channel.sent).toHaveLength(before);
    end();
    service.handleHelperResult({
      type: 'helper-clipboard-result',
      controlSessionId: SESSION_ID,
      transferId: write.transferId,
      outcome: 'ok',
    });
    expect(channel.sent).toHaveLength(before);
  });
});
