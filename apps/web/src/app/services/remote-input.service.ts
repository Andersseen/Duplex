import { computed, signal } from '@angular/core';
import {
  INPUT_PROTOCOL_VERSION,
  MAX_INPUT_EVENTS_PER_SECOND,
  MAX_INPUT_MESSAGE_BYTES,
  MAX_INPUT_SCROLL_DELTA,
  inputKeyboardSchema,
  inputMessageSchema,
} from '@duplex/protocol';
import type { InputMessage, InputPointerButtonName } from '@duplex/protocol';
import { DATA_CHANNEL_LABELS } from '@duplex/webrtc';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';
import type { ActiveControlSession, ControlService } from './control.service';

/** Above this many queued bytes, stale pointer-move updates are dropped instead of queued. */
export const INPUT_BACKPRESSURE_BYTES = 16 * 1024;
const FRAME_FALLBACK_MS = 16;
const LINE_SCROLL_UNITS = 16;
const PAGE_SCROLL_UNITS = 800;

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

/** Convert a browser WheelEvent delta into the bounded logical units of the input protocol. */
export function normalizeWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
): { readonly deltaX: number; readonly deltaY: number } {
  const factor = deltaMode === 1 ? LINE_SCROLL_UNITS : deltaMode === 2 ? PAGE_SCROLL_UNITS : 1;
  return { deltaX: boundScroll(deltaX * factor), deltaY: boundScroll(deltaY * factor) };
}

function boundScroll(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_INPUT_SCROLL_DELTA, Math.min(MAX_INPUT_SCROLL_DELTA, value));
}

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const defaultScheduler: FrameScheduler = {
  request: (callback) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(callback)
      : (setTimeout(callback, FRAME_FALLBACK_MS) as unknown as number),
  cancel: (handle) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    else clearTimeout(handle);
  },
};

/**
 * Native pointer and keyboard input over the dedicated `duplex-input` channel.
 *
 * Controller side: captures input only for the scopes in a live grant.
 * Controlled side: independently validates every message before handing it to the helper relay.
 */
export class RemoteInputService {
  readonly channelOpen = signal(false);
  /** True only while this browser may send native pointer input. */
  readonly capturing = computed(() => {
    const session = this.control.session();
    return (
      this.channelOpen() &&
      session?.role === 'controller' &&
      session.scopes.includes('pointer') &&
      this.control.peerAvailableScopes().includes('pointer') &&
      this.control.peerSurfaceId() === session.surfaceId
    );
  });
  /** True only while this browser may send native keyboard input to the peer helper. */
  readonly keyboardCapturing = computed(() => {
    const session = this.control.session();
    return (
      this.channelOpen() &&
      session?.role === 'controller' &&
      session.scopes.includes('keyboard') &&
      this.control.peerAvailableScopes().includes('keyboard') &&
      this.control.peerSurfaceId() === session.surfaceId
    );
  });

  private channel: DuplexDataChannel | null = null;
  private unsubscribe: (() => void) | null = null;
  private relay: ((input: InputMessage) => boolean) | null = null;
  private sequence = 0;
  private lastReceivedSequence = -1;
  private frame: number | null = null;
  private pendingMove: NormalizedPoint | null = null;
  private pendingScroll: { deltaX: number; deltaY: number } | null = null;
  private lastPoint: NormalizedPoint = { x: 0, y: 0 };
  private readonly pressed = new Set<InputPointerButtonName>();
  private readonly pressedKeys = new Set<string>();
  private rateWindowStart = 0;
  private rateCount = 0;

  constructor(
    private readonly control: ControlService,
    private readonly scheduler: FrameScheduler = defaultScheduler,
    private readonly now: () => number = () => Date.now(),
  ) {
    control.addSessionObserver((event) => {
      // Release before teardown while the session is still valid, then forget everything.
      if (event === 'ending') this.releaseHeld();
      this.resetState();
    });
  }

  /** The controlled browser forwards validated input through this; returns whether it was sent. */
  setHelperRelay(relay: ((input: InputMessage) => boolean) | null): void {
    this.relay = relay;
  }

  attachChannel(channel: DuplexDataChannel): void {
    if (channel.label !== DATA_CHANNEL_LABELS.input || this.channel === channel) return;
    this.detachChannel();
    this.channel = channel;
    const onEvent = (event: DuplexDataChannelEvent): void => {
      if (event.type === 'message') this.receive(event.data);
      else if (event.type === 'open') this.channelOpen.set(true);
      else if (this.channel === channel) this.channelClosed();
    };
    this.unsubscribe = channel.subscribe(onEvent);
    this.channelOpen.set(channel.state === 'open');
  }

  peerChanged(): void {
    this.detachChannel();
    this.resetState();
  }

  // ----- Controller side -------------------------------------------------------------------

  movePointer(point: NormalizedPoint): void {
    if (!this.capturing() || !validPoint(point)) return;
    this.lastPoint = point;
    this.pendingMove = point;
    this.scheduleFlush();
  }

  pointerButton(
    button: InputPointerButtonName,
    state: 'down' | 'up',
    point: NormalizedPoint,
  ): void {
    const session = this.activeControllerSession();
    if (!session || !validPoint(point)) return;
    // Discrete actions keep their order relative to coalesced scroll and never wait for a frame.
    this.flushScroll(session);
    this.pendingMove = null;
    this.lastPoint = point;
    if (state === 'down') this.pressed.add(button);
    else this.pressed.delete(button);
    this.send({
      type: 'input-pointer-button',
      ...this.envelope(session),
      button,
      state,
      x: point.x,
      y: point.y,
    });
  }

  scroll(deltaX: number, deltaY: number): void {
    if (!this.capturing()) return;
    const pending = this.pendingScroll ?? { deltaX: 0, deltaY: 0 };
    pending.deltaX = boundScroll(pending.deltaX + (Number.isFinite(deltaX) ? deltaX : 0));
    pending.deltaY = boundScroll(pending.deltaY + (Number.isFinite(deltaY) ? deltaY : 0));
    this.pendingScroll = pending;
    this.scheduleFlush();
  }

  keyboard(code: string, state: 'down' | 'up'): void {
    const session = this.activeKeyboardControllerSession();
    if (!session || !inputKeyboardSchema.shape.code.safeParse(code).success) return;
    if (this.send({ type: 'input-keyboard', ...this.envelope(session), code, state })) {
      if (state === 'down') this.pressedKeys.add(code);
      else this.pressedKeys.delete(code);
    }
  }

  /** Send `up` for every button this browser believes is held. */
  releaseHeld(): void {
    const session = this.currentControllerSession();
    const buttons = [...this.pressed];
    const keys = [...this.pressedKeys];
    this.pressed.clear();
    this.pressedKeys.clear();
    this.cancelFrame();
    this.pendingMove = null;
    this.pendingScroll = null;
    if (!session) return;
    if (session.scopes.includes('pointer')) {
      for (const button of buttons)
        this.send({
          type: 'input-pointer-button',
          ...this.envelope(session),
          button,
          state: 'up',
          x: this.lastPoint.x,
          y: this.lastPoint.y,
        });
    }
    if (session.scopes.includes('keyboard'))
      for (const code of keys)
        this.send({ type: 'input-keyboard', ...this.envelope(session), code, state: 'up' });
  }

  /** Last position sent; a release with no usable coordinates reuses it rather than jumping. */
  lastPointer(): NormalizedPoint {
    return this.lastPoint;
  }

  hasHeldButtons(): boolean {
    return this.pressed.size > 0;
  }

  private activeControllerSession(): ActiveControlSession | null {
    return this.capturing() ? this.control.session() : null;
  }

  private activeKeyboardControllerSession(): ActiveControlSession | null {
    return this.keyboardCapturing() ? this.control.session() : null;
  }

  private currentControllerSession(): ActiveControlSession | null {
    const session = this.control.session();
    return this.channel?.state === 'open' && session?.role === 'controller' ? session : null;
  }

  private envelope(session: ActiveControlSession): {
    protocolVersion: typeof INPUT_PROTOCOL_VERSION;
    controlSessionId: string;
    surfaceId: string;
    sequence: number;
  } {
    return {
      protocolVersion: INPUT_PROTOCOL_VERSION,
      controlSessionId: session.controlSessionId,
      surfaceId: session.surfaceId,
      sequence: ++this.sequence,
    };
  }

  private scheduleFlush(): void {
    this.frame ??= this.scheduler.request(() => {
      this.frame = null;
      this.flushFrame();
    });
  }

  private flushFrame(): void {
    const session = this.activeControllerSession();
    if (!session) {
      this.pendingMove = null;
      this.pendingScroll = null;
      return;
    }
    this.flushScroll(session);
    const move = this.pendingMove;
    this.pendingMove = null;
    // Stale motion is the only thing dropped under backpressure; the newest position wins next frame.
    if (move && (this.channel?.bufferedAmount ?? 0) <= INPUT_BACKPRESSURE_BYTES)
      this.send({ type: 'input-pointer-move', ...this.envelope(session), x: move.x, y: move.y });
  }

  private flushScroll(session: ActiveControlSession): void {
    const scroll = this.pendingScroll;
    this.pendingScroll = null;
    if (scroll && (scroll.deltaX !== 0 || scroll.deltaY !== 0))
      this.send({ type: 'input-scroll', ...this.envelope(session), ...scroll });
  }

  private send(message: InputMessage): boolean {
    if (this.channel?.state !== 'open') return false;
    try {
      this.channel.sendText(JSON.stringify(message));
      return true;
    } catch {
      // Input transport failures must not affect the call; the helper releases buttons on revoke.
      return false;
    }
  }

  // ----- Controlled side -------------------------------------------------------------------

  private receive(raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string' || raw.length > MAX_INPUT_MESSAGE_BYTES) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = inputMessageSchema.safeParse(data);
    if (!parsed.success) return;
    const input = parsed.data;
    const session = this.control.session();
    if (
      session?.role !== 'controlled' ||
      input.controlSessionId !== session.controlSessionId ||
      input.surfaceId !== session.surfaceId ||
      !(input.type === 'input-keyboard'
        ? session.scopes.includes('keyboard')
        : session.scopes.includes('pointer')) ||
      session.expiresAt <= this.now() ||
      !this.control.helperConnected() ||
      this.control.localSurfaceId() !== session.surfaceId ||
      !(input.type === 'input-keyboard'
        ? this.control.localAvailableScopes().includes('keyboard')
        : this.control.localAvailableScopes().includes('pointer')) ||
      input.sequence <= this.lastReceivedSequence
    )
      return;
    // Releasing a button must always get through; everything else is rate limited.
    const isRelease =
      (input.type === 'input-pointer-button' && input.state === 'up') ||
      (input.type === 'input-keyboard' && input.state === 'up');
    if (!isRelease && !this.withinRate()) return;
    this.lastReceivedSequence = input.sequence;
    this.relay?.(input);
  }

  private withinRate(): boolean {
    const now = this.now();
    if (now - this.rateWindowStart >= 1000) {
      this.rateWindowStart = now;
      this.rateCount = 0;
    }
    this.rateCount += 1;
    return this.rateCount <= MAX_INPUT_EVENTS_PER_SECOND;
  }

  // ----- Lifecycle -------------------------------------------------------------------------

  private channelClosed(): void {
    const hadSession = (this.control.session()?.scopes.length ?? 0) > 0;
    this.detachChannel();
    this.resetState();
    if (hadSession) this.control.endSession('disconnected');
  }

  private resetState(): void {
    this.cancelFrame();
    this.pendingMove = null;
    this.pendingScroll = null;
    this.pressed.clear();
    this.pressedKeys.clear();
    this.sequence = 0;
    this.lastReceivedSequence = -1;
    this.rateWindowStart = 0;
    this.rateCount = 0;
  }

  private cancelFrame(): void {
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
  }

  private detachChannel(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.channel = null;
    this.channelOpen.set(false);
  }
}

function validPoint(point: NormalizedPoint): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
  );
}
