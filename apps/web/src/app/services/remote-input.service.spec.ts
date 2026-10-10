import { afterEach, describe, expect, it, vi } from 'vitest';
import { INPUT_PROTOCOL_VERSION, MAX_INPUT_EVENTS_PER_SECOND } from '@duplex/protocol';
import type { InputMessage } from '@duplex/protocol';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';
import { ControlService } from './control.service';
import {
  INPUT_BACKPRESSURE_BYTES,
  RemoteInputService,
  normalizeWheelDelta,
} from './remote-input.service';
import type { FrameScheduler } from './remote-input.service';

class FakeChannel implements DuplexDataChannel {
  state: DuplexDataChannel['state'] = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];
  private listeners = new Set<(event: DuplexDataChannelEvent) => void>();
  constructor(readonly label: 'duplex-control' | 'duplex-input') {}
  open(): void {
    this.state = 'open';
    for (const listener of this.listeners) listener({ type: 'open' });
  }
  receive(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    for (const listener of this.listeners) listener({ type: 'message', data });
  }
  receiveRaw(data: string | ArrayBuffer): void {
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
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.state = 'closed';
    for (const listener of this.listeners) listener({ type: 'close' });
  }
  messages(): InputMessage[] {
    return this.sent.map((value) => JSON.parse(value) as InputMessage);
  }
}

class ManualScheduler implements FrameScheduler {
  private next = 1;
  private readonly callbacks = new Map<number, () => void>();
  request(callback: () => void): number {
    const handle = this.next++;
    this.callbacks.set(handle, callback);
    return handle;
  }
  cancel(handle: number): void {
    this.callbacks.delete(handle);
  }
  get pending(): number {
    return this.callbacks.size;
  }
  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

interface Rig {
  readonly control: ControlService;
  readonly service: RemoteInputService;
  readonly controlChannel: FakeChannel;
  readonly inputChannel: FakeChannel;
  readonly scheduler: ManualScheduler;
  readonly surfaceId: string;
  readonly relayed: InputMessage[];
}

function rig(): Rig {
  const control = new ControlService();
  const scheduler = new ManualScheduler();
  const service = new RemoteInputService(control, scheduler);
  const controlChannel = new FakeChannel('duplex-control');
  const inputChannel = new FakeChannel('duplex-input');
  control.attachChannel(controlChannel);
  controlChannel.open();
  service.attachChannel(inputChannel);
  inputChannel.open();
  const relayed: InputMessage[] = [];
  service.setHelperRelay((input) => {
    relayed.push(input);
    return true;
  });
  return {
    control,
    service,
    controlChannel,
    inputChannel,
    scheduler,
    surfaceId: crypto.randomUUID(),
    relayed,
  };
}

/** Make this participant the controller of the peer's native-input-capable monitor share. */
function startControlling(
  r: Rig,
  scopes: readonly ('pointer' | 'keyboard')[] = ['pointer'],
): string {
  r.control.setPeerMedia('screen', r.surfaceId);
  r.controlChannel.receive({
    type: 'control-capability',
    protocolVersion: 1,
    surfaceId: r.surfaceId,
    helperConnected: true,
    availableScopes: ['pointer', 'keyboard'],
  });
  r.control.requestControl(scopes);
  const request = JSON.parse(r.controlChannel.sent.at(-1) ?? '{}') as { requestId: string };
  const controlSessionId = crypto.randomUUID();
  r.controlChannel.receive({
    type: 'control-granted',
    protocolVersion: 1,
    surfaceId: r.surfaceId,
    requestId: request.requestId,
    controlSessionId,
    scopes,
    expiresAt: Date.now() + 60_000,
  });
  return controlSessionId;
}

/** Make this participant the controlled side with a ready helper. */
function startBeingControlled(
  r: Rig,
  scopes: readonly ('pointer' | 'keyboard')[] = ['pointer'],
): string {
  r.control.setLocalScreen(r.surfaceId, true);
  r.control.setHelperConnected(true);
  r.control.setHelperScopes(['pointer', 'keyboard']);
  r.controlChannel.receive({
    type: 'control-request',
    protocolVersion: 1,
    surfaceId: r.surfaceId,
    requestId: crypto.randomUUID(),
    scopes,
  });
  r.control.allow();
  const session = r.control.session();
  if (!session) throw new Error('Session was not granted.');
  return session.controlSessionId;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteInputService — controller', () => {
  it('sends nothing without a controlling session', () => {
    const r = rig();
    r.service.movePointer({ x: 0.5, y: 0.5 });
    r.service.pointerButton('left', 'down', { x: 0.5, y: 0.5 });
    r.service.scroll(0, 10);
    r.scheduler.flush();
    expect(r.inputChannel.sent).toEqual([]);
    expect(r.service.capturing()).toBe(false);
  });

  it('blocks pointer input for a keyboard-only session', () => {
    const r = rig();
    startControlling(r, ['keyboard']);
    expect(r.control.session()?.scopes).toEqual(['keyboard']);
    r.service.movePointer({ x: 0.1, y: 0.1 });
    r.scheduler.flush();
    expect(r.inputChannel.sent).toEqual([]);
  });

  it('sends keyboard only for a granted keyboard scope and releases held keys on session end', () => {
    const r = rig();
    startControlling(r, ['keyboard']);
    expect(r.service.capturing()).toBe(false);
    expect(r.service.keyboardCapturing()).toBe(true);
    r.service.keyboard('KeyA', 'down');
    r.service.keyboard('KeyNotSupported', 'down');
    r.control.release();
    expect(r.inputChannel.messages()).toMatchObject([
      { type: 'input-keyboard', code: 'KeyA', state: 'down' },
      { type: 'input-keyboard', code: 'KeyA', state: 'up' },
    ]);
  });

  it('sends nothing when the input channel is closed or the peer lost its capability', () => {
    const r = rig();
    startControlling(r);
    expect(r.service.capturing()).toBe(true);
    r.controlChannel.receive({
      type: 'control-capability',
      protocolVersion: 1,
      surfaceId: r.surfaceId,
      helperConnected: true,
      availableScopes: [],
    });
    r.service.movePointer({ x: 0.1, y: 0.1 });
    r.scheduler.flush();
    expect(r.inputChannel.sent).toEqual([]);
  });

  it('drops input once the peer surface has changed', () => {
    const r = rig();
    startControlling(r);
    r.control.setPeerMedia('screen', crypto.randomUUID());
    expect(r.service.capturing()).toBe(false);
    r.service.movePointer({ x: 0.2, y: 0.2 });
    r.scheduler.flush();
    expect(r.inputChannel.sent).toEqual([]);
  });

  it('sends normalized moves with the session and surface, coalesced to the newest per frame', () => {
    const r = rig();
    const controlSessionId = startControlling(r);
    r.service.movePointer({ x: 0.1, y: 0.1 });
    r.service.movePointer({ x: 0.2, y: 0.3 });
    r.service.movePointer({ x: 0.9, y: 0.4 });
    expect(r.scheduler.pending).toBe(1);
    expect(r.inputChannel.sent).toHaveLength(0);
    r.scheduler.flush();
    expect(r.inputChannel.messages()).toEqual([
      {
        type: 'input-pointer-move',
        protocolVersion: INPUT_PROTOCOL_VERSION,
        controlSessionId,
        surfaceId: r.surfaceId,
        sequence: 1,
        x: 0.9,
        y: 0.4,
      },
    ]);
    r.service.movePointer({ x: 0.5, y: 0.5 });
    r.scheduler.flush();
    expect(r.inputChannel.messages().map((message) => message.sequence)).toEqual([1, 2]);
  });

  it('rejects non-normalized points', () => {
    const r = rig();
    startControlling(r);
    r.service.movePointer({ x: 1.5, y: 0.5 });
    r.service.movePointer({ x: Number.NaN, y: 0.5 });
    r.service.pointerButton('left', 'down', { x: -1, y: 0 });
    r.scheduler.flush();
    expect(r.inputChannel.sent).toEqual([]);
  });

  it('sends button actions immediately and in order, including a drag', () => {
    const r = rig();
    startControlling(r);
    r.service.movePointer({ x: 0.1, y: 0.1 });
    r.service.pointerButton('left', 'down', { x: 0.1, y: 0.1 });
    // The button carries the position, so the stale pending move is not sent after it.
    expect(r.inputChannel.messages().map((m) => m.type)).toEqual(['input-pointer-button']);
    r.service.movePointer({ x: 0.5, y: 0.5 });
    r.scheduler.flush();
    r.service.pointerButton('left', 'up', { x: 0.5, y: 0.5 });
    r.service.pointerButton('right', 'down', { x: 0.5, y: 0.5 });
    r.service.pointerButton('right', 'up', { x: 0.5, y: 0.5 });
    const messages = r.inputChannel.messages();
    expect(
      messages.map((m) => (m.type === 'input-pointer-button' ? `${m.button}-${m.state}` : m.type)),
    ).toEqual(['left-down', 'input-pointer-move', 'left-up', 'right-down', 'right-up']);
    expect(messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(r.service.hasHeldButtons()).toBe(false);
  });

  it('coalesces scroll per frame, bounds it, and keeps it ordered ahead of a button', () => {
    const r = rig();
    startControlling(r);
    r.service.scroll(0, 30);
    r.service.scroll(5, 30);
    r.service.scroll(Number.NaN, Number.POSITIVE_INFINITY);
    r.service.scroll(0, 1_000_000);
    r.scheduler.flush();
    expect(r.inputChannel.messages()).toMatchObject([
      { type: 'input-scroll', deltaX: 5, deltaY: 2000 },
    ]);
    r.service.scroll(0, -10);
    r.service.pointerButton('left', 'down', { x: 0.5, y: 0.5 });
    expect(r.inputChannel.messages().map((m) => m.type)).toEqual([
      'input-scroll',
      'input-scroll',
      'input-pointer-button',
    ]);
  });

  it('normalizes wheel line and page deltas into bounded logical units', () => {
    expect(normalizeWheelDelta(0, 3, 1)).toEqual({ deltaX: 0, deltaY: 48 });
    expect(normalizeWheelDelta(0, 100, 2)).toEqual({ deltaX: 0, deltaY: 2000 });
    expect(normalizeWheelDelta(Number.NaN, -1e12, 0)).toEqual({ deltaX: 0, deltaY: -2000 });
  });

  it('drops stale moves under backpressure but never buttons or scroll', () => {
    const r = rig();
    startControlling(r);
    r.inputChannel.bufferedAmount = INPUT_BACKPRESSURE_BYTES + 1;
    r.service.movePointer({ x: 0.4, y: 0.4 });
    r.scheduler.flush();
    expect(r.inputChannel.sent).toEqual([]);
    r.service.scroll(0, 10);
    r.service.pointerButton('left', 'down', { x: 0.4, y: 0.4 });
    r.service.pointerButton('left', 'up', { x: 0.4, y: 0.4 });
    r.scheduler.flush();
    expect(r.inputChannel.messages().map((m) => m.type)).toEqual([
      'input-scroll',
      'input-pointer-button',
      'input-pointer-button',
    ]);
    r.inputChannel.bufferedAmount = 0;
    r.service.movePointer({ x: 0.6, y: 0.6 });
    r.scheduler.flush();
    expect(r.inputChannel.messages().at(-1)).toMatchObject({ type: 'input-pointer-move', x: 0.6 });
  });

  it('releases held buttons before a user release and stops capturing afterward', () => {
    const r = rig();
    const controlSessionId = startControlling(r);
    r.service.pointerButton('left', 'down', { x: 0.3, y: 0.7 });
    r.service.movePointer({ x: 0.31, y: 0.71 });
    r.control.release();
    const messages = r.inputChannel.messages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      type: 'input-pointer-button',
      button: 'left',
      state: 'up',
      controlSessionId,
      x: 0.31,
      y: 0.71,
    });
    expect(r.service.capturing()).toBe(false);
    // The pending move was cancelled with the session.
    r.scheduler.flush();
    expect(r.inputChannel.sent).toHaveLength(2);
    r.service.movePointer({ x: 0.5, y: 0.5 });
    r.scheduler.flush();
    expect(r.inputChannel.sent).toHaveLength(2);
  });

  it('resets sequence and state for a new session', () => {
    const r = rig();
    startControlling(r);
    r.service.pointerButton('left', 'down', { x: 0.1, y: 0.1 });
    r.control.release();
    startControlling(r);
    r.service.movePointer({ x: 0.2, y: 0.2 });
    r.scheduler.flush();
    const last = r.inputChannel.messages().at(-1);
    expect(last).toMatchObject({ type: 'input-pointer-move', sequence: 1 });
    expect(r.service.hasHeldButtons()).toBe(false);
  });

  it('ends the session and stops when the input channel closes', () => {
    const r = rig();
    startControlling(r);
    r.service.movePointer({ x: 0.2, y: 0.2 });
    r.inputChannel.close();
    expect(r.control.session()).toBeNull();
    expect(r.service.capturing()).toBe(false);
    r.scheduler.flush();
    expect(r.inputChannel.sent).toEqual([]);
  });

  it('clears everything when the peer changes', () => {
    const r = rig();
    startControlling(r);
    r.service.pointerButton('right', 'down', { x: 0.2, y: 0.2 });
    r.control.peerChanged();
    r.service.peerChanged();
    expect(r.service.hasHeldButtons()).toBe(false);
    expect(r.service.channelOpen()).toBe(false);
  });
});

describe('RemoteInputService — controlled', () => {
  const move = (controlSessionId: string, surfaceId: string, sequence: number): InputMessage => ({
    type: 'input-pointer-move',
    protocolVersion: INPUT_PROTOCOL_VERSION,
    controlSessionId,
    surfaceId,
    sequence,
    x: 0.5,
    y: 0.5,
  });

  it('relays valid input for the active controlled session to the helper', () => {
    const r = rig();
    const sessionId = startBeingControlled(r);
    const message = move(sessionId, r.surfaceId, 1);
    r.inputChannel.receive(message);
    r.inputChannel.receive({
      type: 'input-pointer-button',
      protocolVersion: INPUT_PROTOCOL_VERSION,
      controlSessionId: sessionId,
      surfaceId: r.surfaceId,
      sequence: 2,
      button: 'left',
      state: 'down',
      x: 0.1,
      y: 0.2,
    });
    expect(r.relayed.map((m) => m.type)).toEqual(['input-pointer-move', 'input-pointer-button']);
    expect(r.relayed[0]).toEqual(message);
  });

  it('relays keyboard only for a keyboard-scoped session and bypasses rate limits for key-up', () => {
    const r = rig();
    const sessionId = startBeingControlled(r, ['keyboard']);
    const key = {
      type: 'input-keyboard',
      protocolVersion: INPUT_PROTOCOL_VERSION,
      controlSessionId: sessionId,
      surfaceId: r.surfaceId,
      sequence: 1,
      code: 'KeyA',
      state: 'down',
    } as const;
    r.inputChannel.receive(key);
    r.inputChannel.receive({ ...key, sequence: 2, state: 'up' });
    expect(r.relayed).toEqual([key, { ...key, sequence: 2, state: 'up' }]);
  });

  it('drops input when there is no controlled session or the role is wrong', () => {
    const r = rig();
    r.inputChannel.receive(move(crypto.randomUUID(), r.surfaceId, 1));
    expect(r.relayed).toEqual([]);
    const controller = rig();
    const sessionId = startControlling(controller);
    controller.inputChannel.receive(move(sessionId, controller.surfaceId, 1));
    expect(controller.relayed).toEqual([]);
  });

  it('drops a wrong session id and a wrong surface id', () => {
    const r = rig();
    const sessionId = startBeingControlled(r);
    r.inputChannel.receive(move(crypto.randomUUID(), r.surfaceId, 1));
    r.inputChannel.receive(move(sessionId, crypto.randomUUID(), 2));
    expect(r.relayed).toEqual([]);
    r.inputChannel.receive(move(sessionId, r.surfaceId, 3));
    expect(r.relayed).toHaveLength(1);
  });

  it('ignores duplicate and older sequences', () => {
    const r = rig();
    const sessionId = startBeingControlled(r);
    r.inputChannel.receive(move(sessionId, r.surfaceId, 5));
    r.inputChannel.receive(move(sessionId, r.surfaceId, 5));
    r.inputChannel.receive(move(sessionId, r.surfaceId, 4));
    r.inputChannel.receive(move(sessionId, r.surfaceId, 6));
    expect(r.relayed.map((m) => m.sequence)).toEqual([5, 6]);
  });

  it('never accepts input from a previous grant in a new session', () => {
    const r = rig();
    const first = startBeingControlled(r);
    r.inputChannel.receive(move(first, r.surfaceId, 1));
    r.control.release();
    const second = startBeingControlled(r);
    r.inputChannel.receive(move(first, r.surfaceId, 2));
    expect(r.relayed).toHaveLength(1);
    r.inputChannel.receive(move(second, r.surfaceId, 1));
    expect(r.relayed).toHaveLength(2);
  });

  it('drops input after revoke, helper loss, capability loss and screen stop', () => {
    const r = rig();
    const sessionId = startBeingControlled(r);
    r.control.release();
    r.inputChannel.receive(move(sessionId, r.surfaceId, 1));
    expect(r.relayed).toEqual([]);

    for (const stop of [
      () => {
        r.control.setHelperConnected(false);
      },
      () => {
        r.control.setHelperScopes([]);
      },
      () => {
        r.control.setLocalScreen(null);
      },
    ]) {
      const id = startBeingControlled(r);
      stop();
      r.inputChannel.receive(move(id, r.surfaceId, 1));
      expect(r.relayed).toEqual([]);
    }
  });

  it('drops input when the helper relay is unavailable', () => {
    const r = rig();
    const sessionId = startBeingControlled(r);
    r.service.setHelperRelay(null);
    r.inputChannel.receive(move(sessionId, r.surfaceId, 1));
    expect(r.relayed).toEqual([]);
  });

  it('drops expired sessions even before the timer fires', () => {
    const r = rig();
    const sessionId = startBeingControlled(r);
    const session = r.control.session();
    vi.useFakeTimers();
    vi.setSystemTime((session?.expiresAt ?? 0) + 1);
    r.inputChannel.receive(move(sessionId, r.surfaceId, 1));
    expect(r.relayed).toEqual([]);
  });

  it('rejects malformed, oversized, unsupported key codes and non-text payloads', () => {
    const r = rig();
    const sessionId = startBeingControlled(r);
    const valid = move(sessionId, r.surfaceId, 1);
    r.inputChannel.receive('not json');
    r.inputChannel.receive({ ...valid, x: 2 });
    r.inputChannel.receive({ ...valid, extra: 'key' });
    r.inputChannel.receive({
      type: 'input-keyboard',
      protocolVersion: INPUT_PROTOCOL_VERSION,
      controlSessionId: sessionId,
      surfaceId: r.surfaceId,
      sequence: 1,
      code: 'KeyNotSupported',
      state: 'down',
    });
    r.inputChannel.receive(JSON.stringify(valid) + ' '.repeat(2048));
    r.inputChannel.receiveRaw(new ArrayBuffer(8));
    expect(r.relayed).toEqual([]);
  });

  it('rate limits moves but always lets a button release through', () => {
    const r = rig();
    const sessionId = startBeingControlled(r);
    for (let sequence = 1; sequence <= MAX_INPUT_EVENTS_PER_SECOND + 50; sequence += 1)
      r.inputChannel.receive(move(sessionId, r.surfaceId, sequence));
    expect(r.relayed).toHaveLength(MAX_INPUT_EVENTS_PER_SECOND);
    r.inputChannel.receive({
      type: 'input-pointer-button',
      protocolVersion: INPUT_PROTOCOL_VERSION,
      controlSessionId: sessionId,
      surfaceId: r.surfaceId,
      sequence: MAX_INPUT_EVENTS_PER_SECOND + 100,
      button: 'left',
      state: 'up',
      x: 0.5,
      y: 0.5,
    });
    expect(r.relayed.at(-1)).toMatchObject({ type: 'input-pointer-button', state: 'up' });
  });

  it('ends the controlled session when the input channel closes', () => {
    const r = rig();
    startBeingControlled(r);
    r.inputChannel.close();
    expect(r.control.session()).toBeNull();
  });
});
