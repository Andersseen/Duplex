import { computed, signal } from '@angular/core';
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_REQUEST_TIMEOUT_MS,
  CONTROL_SESSION_MAX_AGE_MS,
  controlMessageSchema,
} from '@duplex/protocol';
import type {
  ControlMessage,
  ControlRevocationReason,
  ControlScope,
  ControlRequestMessage,
} from '@duplex/protocol';
import { DATA_CHANNEL_LABELS } from '@duplex/webrtc';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';

export type ControlState =
  | 'idle'
  | 'requesting'
  | 'incoming-request'
  | 'controlling'
  | 'being-controlled'
  | 'rejected'
  | 'revoked';
export interface ActiveControlSession {
  readonly requestId: string;
  readonly controlSessionId: string;
  readonly surfaceId: string;
  readonly scopes: readonly ControlScope[];
  readonly expiresAt: number;
  readonly role: 'controller' | 'controlled';
}

/** Scopes a native helper can execute today. Keyboard exists in the protocol but not in any helper. */
const NATIVE_EXECUTABLE_SCOPES: readonly ControlScope[] = ['pointer'];

export type ControlSessionEvent = 'started' | 'ending';

export class ControlService {
  readonly state = signal<ControlState>('idle');
  readonly incomingRequest = signal<ControlRequestMessage | null>(null);
  readonly session = signal<ActiveControlSession | null>(null);
  readonly remainingSeconds = signal(0);
  readonly helperConnected = signal(false);
  /** Scopes the controlled peer says its helper can execute right now, for its current screen. */
  readonly peerAvailableScopes = signal<readonly ControlScope[]>([]);
  readonly peerSurfaceId = computed(() => this.peerScreenIdState());
  readonly localSurfaceId = computed(() => this.localScreenIdState());
  /**
   * Scopes this participant's own helper can execute right now. Native control needs a paired
   * helper, an active screen share of an entire monitor, and helper-reported capability.
   */
  readonly localAvailableScopes = computed<readonly ControlScope[]>(() =>
    this.helperConnected() && this.localScreenIdState() !== null && this.nativeEligible()
      ? this.helperScopes()
      : [],
  );
  readonly canRequest = computed(
    () =>
      this.peerScreenIdState() !== null &&
      this.peerHelperConnectedState() &&
      this.peerAvailableScopes().length > 0 &&
      this.controlChannelOpen() &&
      !this.session(),
  );

  private channel: DuplexDataChannel | null = null;
  private channelUnsubscribe: (() => void) | null = null;
  private channelEvents = new Map<DuplexDataChannel, () => void>();
  private localScreenId: string | null = null;
  private readonly localScreenIdState = signal<string | null>(null);
  private readonly nativeEligible = signal(false);
  private readonly helperScopes = signal<readonly ControlScope[]>([]);
  private readonly sessionObservers = new Set<
    (event: ControlSessionEvent, session: ActiveControlSession) => void
  >();
  private peerCapabilityScopes: readonly ControlScope[] = [];
  private peerScreenId: string | null = null;
  private peerHelperConnected = false;
  private readonly peerScreenIdState = signal<string | null>(null);
  private readonly peerHelperConnectedState = signal(false);
  private readonly controlChannelOpen = signal(false);
  private peerCapabilitySurfaceId: string | null = null;
  private peerCapabilityHelperConnected = false;
  private helperSessionListener:
    | ((
        session: ActiveControlSession | null,
        reason?: ControlRevocationReason,
        previous?: ActiveControlSession,
      ) => void)
    | null = null;
  private outgoingRequestId: string | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private requestTimer: ReturnType<typeof setTimeout> | null = null;
  private incomingTimer: ReturnType<typeof setTimeout> | null = null;
  private outgoingScopes: readonly ControlScope[] = [];

  attachChannel(channel: DuplexDataChannel): void {
    if (channel.label !== DATA_CHANNEL_LABELS.control || this.channel === channel) return;
    this.detachChannel();
    this.channel = channel;
    const onEvent = (event: DuplexDataChannelEvent): void => {
      if (event.type === 'message') this.receive(event.data);
      else if (event.type === 'open') {
        this.controlChannelOpen.set(true);
        this.announceCapability();
      } else {
        this.controlChannelOpen.set(false);
        this.revoke('disconnected', false);
      }
    };
    this.channelUnsubscribe = channel.subscribe(onEvent);
    this.channelEvents.set(channel, this.channelUnsubscribe);
    this.controlChannelOpen.set(channel.state === 'open');
    if (channel.state === 'open') this.announceCapability();
  }

  setHelperSessionListener(
    listener: (
      session: ActiveControlSession | null,
      reason?: ControlRevocationReason,
      previous?: ActiveControlSession,
    ) => void,
  ): void {
    this.helperSessionListener = listener;
  }

  /** Observe session start and the moment before it ends, so input state can never outlive a grant. */
  addSessionObserver(
    observer: (event: ControlSessionEvent, session: ActiveControlSession) => void,
  ): () => void {
    this.sessionObservers.add(observer);
    return () => this.sessionObservers.delete(observer);
  }

  /** `nativeEligible` is true only when the browser reported an entire monitor as the source. */
  setLocalScreen(surfaceId: string | null, nativeEligible = false): void {
    if (this.localScreenId !== surfaceId) this.revoke('surface-ended', true);
    this.localScreenId = surfaceId;
    this.localScreenIdState.set(surfaceId);
    this.nativeEligible.set(surfaceId !== null && nativeEligible);
    this.reconcileLocalCapability();
  }

  setPeerMedia(source: 'none' | 'camera' | 'screen', surfaceId: string | null): void {
    const next = source === 'screen' ? surfaceId : null;
    if (this.peerScreenId !== next) this.revoke('surface-ended', true);
    this.peerScreenId = next;
    this.peerHelperConnected =
      this.peerCapabilitySurfaceId === next && this.peerCapabilityHelperConnected;
    this.peerScreenIdState.set(next);
    this.peerHelperConnectedState.set(this.peerHelperConnected);
    this.peerAvailableScopes.set(
      next !== null && this.peerCapabilitySurfaceId === next ? this.peerCapabilityScopes : [],
    );
  }

  setHelperConnected(connected: boolean): void {
    this.helperConnected.set(connected);
    if (!connected) this.helperScopes.set([]);
    this.announceCapability();
    if (!connected) this.revoke('helper-disconnected', true);
  }

  /** Scopes the paired helper reported it can execute. Safe state only; never display details. */
  setHelperScopes(scopes: readonly ControlScope[]): void {
    this.helperScopes.set(
      this.helperConnected()
        ? [...new Set(scopes)].filter((scope) => NATIVE_EXECUTABLE_SCOPES.includes(scope))
        : [],
    );
    this.reconcileLocalCapability();
  }

  requestControl(scopes: readonly ControlScope[] = this.peerAvailableScopes()): void {
    if (
      !this.canRequest() ||
      !this.peerScreenId ||
      scopes.length === 0 ||
      new Set(scopes).size !== scopes.length ||
      !scopes.every((scope) => this.peerAvailableScopes().includes(scope)) ||
      this.incomingRequest() ||
      this.outgoingRequestId !== null
    )
      return;
    const requestId = crypto.randomUUID();
    this.outgoingRequestId = requestId;
    this.outgoingScopes = [...scopes];
    this.state.set('requesting');
    this.send({
      type: 'control-request',
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      surfaceId: this.peerScreenId,
      requestId,
      scopes: [...scopes],
    });
    this.requestTimer = setTimeout(() => {
      if (this.outgoingRequestId !== requestId) return;
      this.clearRequest();
      this.state.set('revoked');
    }, CONTROL_REQUEST_TIMEOUT_MS);
  }

  reject(): void {
    const request = this.incomingRequest();
    if (!request) return;
    this.send({
      type: 'control-rejected',
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      surfaceId: request.surfaceId,
      requestId: request.requestId,
    });
    this.clearIncomingRequest();
    this.state.set('rejected');
  }

  allow(scopes?: readonly ControlScope[]): void {
    const request = this.incomingRequest();
    if (
      !request ||
      !this.localScreenId ||
      request.surfaceId !== this.localScreenId ||
      !this.helperConnected()
    )
      return;
    const grantedScopes = (scopes ?? request.scopes).filter(
      (scope) => request.scopes.includes(scope) && this.localAvailableScopes().includes(scope),
    );
    if (!grantedScopes.length) {
      this.reject();
      return;
    }
    const controlSessionId = crypto.randomUUID();
    const expiresAt = Date.now() + CONTROL_SESSION_MAX_AGE_MS;
    const session: ActiveControlSession = {
      requestId: request.requestId,
      controlSessionId,
      surfaceId: request.surfaceId,
      scopes: grantedScopes,
      expiresAt,
      role: 'controlled',
    };
    this.send({
      type: 'control-granted',
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      surfaceId: request.surfaceId,
      requestId: request.requestId,
      controlSessionId,
      scopes: grantedScopes,
      expiresAt,
    });
    this.clearIncomingRequest();
    this.activate(session);
  }

  release(): void {
    this.revoke('user', true);
  }

  /** End the active session for a non-user reason, telling the peer and the helper. */
  endSession(reason: ControlRevocationReason): void {
    this.revoke(reason, true);
  }

  peerChanged(): void {
    this.revoke('disconnected', true);
    this.peerScreenId = null;
    this.peerHelperConnected = false;
    this.peerScreenIdState.set(null);
    this.peerHelperConnectedState.set(false);
    this.peerCapabilitySurfaceId = null;
    this.peerCapabilityHelperConnected = false;
    this.peerCapabilityScopes = [];
    this.peerAvailableScopes.set([]);
    this.detachChannel();
    this.state.set('idle');
  }

  private receive(raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const parsed = controlMessageSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'control-capability') {
      this.peerCapabilitySurfaceId = message.surfaceId;
      this.peerCapabilityHelperConnected = message.helperConnected;
      this.peerCapabilityScopes = message.helperConnected ? message.availableScopes : [];
      if (message.surfaceId === this.peerScreenId) {
        this.peerHelperConnected = message.helperConnected;
        this.peerHelperConnectedState.set(message.helperConnected);
        this.peerAvailableScopes.set(this.peerCapabilityScopes);
        if (!message.helperConnected) this.revoke('helper-disconnected', false);
        else {
          const active = this.session();
          if (
            active?.role === 'controller' &&
            !active.scopes.every((scope) => this.peerCapabilityScopes.includes(scope))
          )
            this.revoke('capability-lost', false);
        }
      }
      return;
    }
    if (message.surfaceId !== this.localScreenId && message.type === 'control-request') {
      this.send({
        type: 'control-rejected',
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        surfaceId: message.surfaceId,
        requestId: message.requestId,
      });
      return;
    }
    if (message.type === 'control-request') {
      if (
        !this.localScreenId ||
        message.surfaceId !== this.localScreenId ||
        !this.helperConnected() ||
        !message.scopes.every((scope) => this.localAvailableScopes().includes(scope)) ||
        this.incomingRequest() ||
        this.outgoingRequestId !== null ||
        this.session()
      ) {
        this.send({
          type: 'control-rejected',
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          surfaceId: message.surfaceId,
          requestId: message.requestId,
        });
        return;
      }
      this.incomingRequest.set(message);
      this.state.set('incoming-request');
      this.incomingTimer = setTimeout(() => {
        if (this.incomingRequest()?.requestId !== message.requestId) return;
        this.clearIncomingRequest();
        this.state.set('revoked');
      }, CONTROL_REQUEST_TIMEOUT_MS);
    } else if (
      message.type === 'control-rejected' &&
      this.outgoingRequestId === message.requestId
    ) {
      this.clearRequest();
      this.state.set('rejected');
    } else if (
      message.type === 'control-granted' &&
      this.outgoingRequestId === message.requestId &&
      message.surfaceId === this.peerScreenId &&
      message.scopes.every((scope) => this.outgoingScopes.includes(scope))
    ) {
      this.clearRequest();
      const boundedExpiry = Math.min(message.expiresAt, Date.now() + CONTROL_SESSION_MAX_AGE_MS);
      if (boundedExpiry <= Date.now()) {
        this.state.set('revoked');
        return;
      }
      this.activate({ ...message, expiresAt: boundedExpiry, role: 'controller' });
    } else if (
      message.type === 'control-revoked' &&
      this.session()?.controlSessionId === message.controlSessionId &&
      this.session()?.surfaceId === message.surfaceId &&
      this.session()?.requestId === message.requestId
    ) {
      const current = this.session();
      if (current?.role === 'controlled')
        this.helperSessionListener?.(null, message.reason, current);
      this.clearSession();
      this.state.set('revoked');
    }
  }

  private announceCapability(): void {
    if (this.localScreenId)
      this.send({
        type: 'control-capability',
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        surfaceId: this.localScreenId,
        helperConnected: this.helperConnected(),
        availableScopes: [...this.localAvailableScopes()],
      });
  }

  /** Re-announce and revoke an active grant whose scopes the helper can no longer execute. */
  private reconcileLocalCapability(): void {
    this.announceCapability();
    const active = this.session();
    if (
      active?.role === 'controlled' &&
      !active.scopes.every((scope) => this.localAvailableScopes().includes(scope))
    )
      this.revoke('capability-lost', true);
  }

  private notifySession(event: ControlSessionEvent, session: ActiveControlSession): void {
    for (const observer of this.sessionObservers) observer(event, session);
  }
  private activate(session: ActiveControlSession): void {
    this.clearSession();
    this.session.set(session);
    this.state.set(session.role === 'controller' ? 'controlling' : 'being-controlled');
    this.notifySession('started', session);
    if (session.role === 'controlled') this.helperSessionListener?.(session);
    const updateCountdown = (): void => {
      this.remainingSeconds.set(Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)));
    };
    updateCountdown();
    this.countdownTimer = setInterval(updateCountdown, 1000);
    this.expiryTimer = setTimeout(
      () => {
        this.revoke('expired', true);
      },
      Math.max(0, session.expiresAt - Date.now()),
    );
  }
  private revoke(reason: ControlRevocationReason, notify: boolean): void {
    const session = this.session();
    if (session) this.notifySession('ending', session);
    if (session && notify)
      this.send({
        type: 'control-revoked',
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        surfaceId: session.surfaceId,
        requestId: session.requestId,
        controlSessionId: session.controlSessionId,
        reason,
      });
    if (session?.role === 'controlled') this.helperSessionListener?.(null, reason, session);
    const hadPending = this.incomingRequest() !== null || this.outgoingRequestId !== null;
    if (session || hadPending) {
      this.clearIncomingRequest();
      this.clearRequest();
      this.clearSession();
      this.state.set('revoked');
    }
  }
  private send(message: ControlMessage): void {
    if (this.channel?.state === 'open') this.channel.sendText(JSON.stringify(message));
  }
  private clearRequest(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = null;
    this.outgoingRequestId = null;
    this.outgoingScopes = [];
  }
  private clearIncomingRequest(): void {
    if (this.incomingTimer) clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
    this.incomingRequest.set(null);
  }
  private clearSession(): void {
    const ending = this.session();
    if (ending) this.notifySession('ending', ending);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.expiryTimer = null;
    this.countdownTimer = null;
    this.remainingSeconds.set(0);
    this.session.set(null);
  }
  private detachChannel(): void {
    this.channelUnsubscribe?.();
    if (this.channel) this.channelEvents.delete(this.channel);
    this.channel = null;
    this.channelUnsubscribe = null;
    this.controlChannelOpen.set(false);
  }
}
