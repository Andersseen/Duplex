import { computed, signal } from '@angular/core';
import {
  CLIPBOARD_APPROVAL_TIMEOUT_MS,
  CLIPBOARD_MIN_INTERVAL_MS,
  CLIPBOARD_OPERATION_TIMEOUT_MS,
  CLIPBOARD_PROTOCOL_VERSION,
  MAX_CLIPBOARD_MESSAGE_BYTES,
  MAX_CLIPBOARD_TEXT_BYTES,
  clipboardMessageSchema,
  isAcceptableClipboardText,
} from '@duplex/protocol';
import type {
  ClipboardMessage,
  ClipboardOutcome,
  HelperClipboardRead,
  HelperClipboardResult,
  HelperClipboardWrite,
} from '@duplex/protocol';
import { DATA_CHANNEL_LABELS } from '@duplex/webrtc';
import type { DuplexDataChannel, DuplexDataChannelEvent } from '@duplex/webrtc';
import type { ActiveControlSession, ControlService } from './control.service';

/** The two Async Clipboard API calls Duplex uses, so tests and unsupported browsers are explicit. */
export interface ClipboardApi {
  readonly readText?: () => Promise<string>;
  readonly writeText?: (text: string) => Promise<void>;
}

export type ClipboardNoticeTone = 'info' | 'error';
export interface ClipboardNotice {
  readonly tone: ClipboardNoticeTone;
  readonly text: string;
}

/** How long a controlled browser waits for its own helper to answer one clipboard operation. */
const HELPER_ANSWER_TIMEOUT_MS = 10 * 1000;
/** Recent transfer ids remembered per session to ignore duplicate deliveries. */
const REMEMBERED_TRANSFERS = 32;

const OUTCOME_TEXT: Record<Exclude<ClipboardOutcome, 'delivered'>, string> = {
  declined: 'The other person declined to share their clipboard.',
  unavailable: 'Clipboard access is not available on the other computer.',
  empty: 'The other computer has no text on its clipboard.',
  'too-large': `That text is over the ${String(MAX_CLIPBOARD_TEXT_BYTES / 1024)} KiB limit.`,
  denied: 'The other computer refused the clipboard request.',
  busy: 'The other computer is busy with another clipboard request. Try again in a moment.',
  failed: 'The clipboard operation failed. Nothing was changed.',
};

function defaultApi(): ClipboardApi {
  if (typeof window === 'undefined' || !window.isSecureContext) return {};
  // Optional chaining keeps older and non-secure contexts from throwing on access.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  return {
    ...(typeof clipboard?.readText === 'function' ? { readText: () => clipboard.readText() } : {}),
    ...(typeof clipboard?.writeText === 'function'
      ? { writeText: (text: string) => clipboard.writeText(text) }
      : {}),
  };
}

type Pending =
  | { readonly kind: 'send'; readonly transferId: string; readonly characters: number }
  | { readonly kind: 'receive'; readonly transferId: string };

/**
 * Manual, text-only clipboard transfer inside a live Assist grant with the `clipboard` scope.
 *
 * Nothing here watches the clipboard. The controller reads its own clipboard only inside a click
 * handler and writes the remote text only when the user clicks again. The controlled side must
 * approve every read of its clipboard, and its helper independently re-authorizes every operation.
 * Clipboard text is never logged and is dropped as soon as it is delivered or the grant ends.
 */
export class ClipboardService {
  /** Controller view: whether the clipboard actions may be offered right now. */
  readonly available = computed(() => {
    const session = this.control.session();
    return (
      this.channelOpen() &&
      session?.role === 'controller' &&
      session.scopes.includes('clipboard') &&
      this.control.peerAvailableScopes().includes('clipboard') &&
      this.control.peerSurfaceId() === session.surfaceId
    );
  });
  /** Whether this browser exposes the Async Clipboard API calls each action needs. */
  readonly canReadLocal = signal(false);
  readonly canWriteLocal = signal(false);
  readonly busy = computed(() => this.pendingState() !== null);
  readonly notice = signal<ClipboardNotice | null>(null);
  /** Length of remote text waiting for the controller to copy; the text itself is not exposed. */
  readonly receivedCharacters = signal<number | null>(null);
  /** Controlled view: a peer asked to read this computer's clipboard and awaits a decision. */
  readonly incomingRead = signal<{ readonly transferId: string } | null>(null);
  /** Controlled view: the peer placed this many characters on the clipboard (never the text). */
  readonly peerWrote = signal<{ readonly characters: number } | null>(null);

  private readonly channelOpen = signal(false);
  private readonly pendingState = signal<Pending | null>(null);
  private channel: DuplexDataChannel | null = null;
  private unsubscribe: (() => void) | null = null;
  private relay: ((message: HelperClipboardWrite | HelperClipboardRead) => boolean) | null = null;
  private receivedText: string | null = null;
  private outSequence = 0;
  private lastInSequence = -1;
  private lastAcceptedAt: number | null = null;
  private readonly seen: string[] = [];
  private readonly helperPending = new Map<
    string,
    {
      readonly kind: 'write' | 'read';
      readonly sessionId: string;
      readonly surfaceId: string;
      readonly characters: number;
    }
  >();
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly helperTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly control: ControlService,
    private readonly api: ClipboardApi = defaultApi(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.canReadLocal.set(typeof api.readText === 'function');
    this.canWriteLocal.set(typeof api.writeText === 'function');
    // Whatever starts or ends a grant, no transfer state may outlive it.
    control.addSessionObserver(() => {
      this.resetState();
    });
  }

  /** The controlled browser forwards authorized operations to its own helper through this. */
  setHelperRelay(
    relay: ((message: HelperClipboardWrite | HelperClipboardRead) => boolean) | null,
  ): void {
    this.relay = relay;
  }

  attachChannel(channel: DuplexDataChannel): void {
    if (channel.label !== DATA_CHANNEL_LABELS.input || this.channel === channel) return;
    this.detachChannel();
    this.channel = channel;
    const onEvent = (event: DuplexDataChannelEvent): void => {
      if (event.type === 'message') this.receive(event.data);
      else if (event.type === 'open') this.channelOpen.set(true);
      else if (this.channel === channel) this.detachChannel();
    };
    this.unsubscribe = channel.subscribe(onEvent);
    this.channelOpen.set(channel.state === 'open');
  }

  peerChanged(): void {
    this.detachChannel();
    this.resetState();
  }

  // ----- Controller side -------------------------------------------------------------------

  /** Send the local clipboard text to the remote computer. Call only from a user click. */
  async sendLocalClipboard(): Promise<void> {
    const session = this.controllerSession();
    if (!session || this.pendingState()) return;
    const readText = this.api.readText;
    if (!readText) {
      this.fail(
        'This browser cannot read the clipboard. Copy the text into a chat or file instead.',
      );
      return;
    }
    let text: string;
    try {
      text = await readText();
    } catch {
      this.fail(
        'The browser did not allow reading your clipboard. Allow clipboard access for this site and try again.',
      );
      return;
    }
    // The grant may have ended while the browser's permission prompt was open.
    const live = this.controllerSession();
    if (live?.controlSessionId !== session.controlSessionId || this.pendingState()) return;
    if (text.length === 0) {
      this.fail('Your clipboard has no text to send.');
      return;
    }
    if (!isAcceptableClipboardText(text)) {
      this.fail(
        new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_TEXT_BYTES
          ? OUTCOME_TEXT['too-large']
          : 'Your clipboard text contains characters that cannot be sent.',
      );
      return;
    }
    const transferId = crypto.randomUUID();
    if (
      !this.send({
        type: 'clipboard-write',
        ...this.envelope(live),
        transferId,
        text,
      })
    ) {
      this.fail('The connection to the other computer is not ready.');
      return;
    }
    this.begin({ kind: 'send', transferId, characters: text.length });
    this.notice.set({ tone: 'info', text: 'Sending your clipboard text…' });
  }

  /** Ask the remote user to share their clipboard text once. */
  requestRemoteClipboard(): void {
    const session = this.controllerSession();
    if (!session || this.pendingState()) return;
    if (!this.canWriteLocal()) {
      this.fail('This browser cannot write to your clipboard, so remote text could not be copied.');
      return;
    }
    this.discardReceived();
    const transferId = crypto.randomUUID();
    if (!this.send({ type: 'clipboard-read-request', ...this.envelope(session), transferId })) {
      this.fail('The connection to the other computer is not ready.');
      return;
    }
    this.begin({ kind: 'receive', transferId });
    this.notice.set({ tone: 'info', text: 'Waiting for the other person to approve…' });
  }

  /** Copy the received remote text to the local clipboard. Call only from a user click. */
  async copyReceived(): Promise<void> {
    const text = this.receivedText;
    const writeText = this.api.writeText;
    if (text === null || !this.controllerSession()) return;
    if (!writeText) {
      this.fail('This browser cannot write to your clipboard.');
      return;
    }
    try {
      await writeText(text);
    } catch {
      this.fail(
        'The browser did not allow copying to your clipboard. Allow clipboard access for this site and try again.',
      );
      return;
    }
    this.discardReceived();
    this.notice.set({ tone: 'info', text: 'Copied to your clipboard.' });
  }

  discardReceived(): void {
    this.receivedText = null;
    this.receivedCharacters.set(null);
  }

  dismissNotice(): void {
    this.notice.set(null);
  }

  // ----- Controlled side -------------------------------------------------------------------

  approveRead(): void {
    const request = this.incomingRead();
    const session = this.controlledSession();
    this.clearApproval();
    if (!request || !session) return;
    this.forwardToHelper(session, request.transferId, 'read', 0);
  }

  declineRead(): void {
    const request = this.incomingRead();
    const session = this.controlledSession();
    this.clearApproval();
    if (request && session) this.reply(session, request.transferId, 'declined');
  }

  /** The paired helper's answer to a relayed operation. */
  handleHelperResult(result: HelperClipboardResult): void {
    const pending = this.helperPending.get(result.transferId);
    const session = this.controlledSession();
    this.forgetHelperOperation(result.transferId);
    if (
      !pending ||
      !session ||
      pending.sessionId !== result.controlSessionId ||
      session.controlSessionId !== pending.sessionId ||
      session.surfaceId !== pending.surfaceId
    )
      return;
    if (pending.kind === 'write') {
      if (result.outcome === 'ok') {
        this.peerWrote.set({ characters: pending.characters });
        this.reply(session, result.transferId, 'delivered');
      } else this.reply(session, result.transferId, helperOutcome(result.outcome));
      return;
    }
    if (result.outcome === 'ok' && result.text !== undefined) {
      this.send({
        type: 'clipboard-text',
        ...this.envelope(session),
        transferId: result.transferId,
        text: result.text,
      });
    } else this.reply(session, result.transferId, helperOutcome(result.outcome));
  }

  // ----- Inbound messages ------------------------------------------------------------------

  private receive(raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string' || raw.length > MAX_CLIPBOARD_MESSAGE_BYTES) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = clipboardMessageSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    const session = this.control.session();
    if (
      session?.controlSessionId !== message.controlSessionId ||
      message.surfaceId !== session.surfaceId ||
      session.expiresAt <= this.now() ||
      message.sequence <= this.lastInSequence ||
      this.seen.includes(message.transferId)
    )
      return;
    if (
      session.role === 'controlled' &&
      (message.type === 'clipboard-write' || message.type === 'clipboard-read-request')
    )
      this.receiveAsControlled(session, message);
    else if (
      session.role === 'controller' &&
      (message.type === 'clipboard-text' || message.type === 'clipboard-status')
    )
      this.receiveAsController(message);
  }

  private receiveAsControlled(
    session: ActiveControlSession,
    message: Extract<ClipboardMessage, { type: 'clipboard-write' | 'clipboard-read-request' }>,
  ): void {
    // Authorization is checked for every operation, not once per session.
    if (
      !session.scopes.includes('clipboard') ||
      !this.control.helperConnected() ||
      this.control.localSurfaceId() !== session.surfaceId ||
      !this.control.localAvailableScopes().includes('clipboard')
    )
      return;
    this.lastInSequence = message.sequence;
    this.remember(message.transferId);
    const now = this.now();
    const tooSoon =
      this.lastAcceptedAt !== null && now - this.lastAcceptedAt < CLIPBOARD_MIN_INTERVAL_MS;
    if (tooSoon || this.helperPending.size > 0 || this.incomingRead() !== null) {
      this.reply(session, message.transferId, 'busy');
      return;
    }
    this.lastAcceptedAt = now;
    if (message.type === 'clipboard-write') {
      this.forwardToHelper(session, message.transferId, 'write', message.text.length, message.text);
      return;
    }
    this.incomingRead.set({ transferId: message.transferId });
    this.approvalTimer = setTimeout(() => {
      this.declineRead();
    }, CLIPBOARD_APPROVAL_TIMEOUT_MS);
  }

  private receiveAsController(
    message: Extract<ClipboardMessage, { type: 'clipboard-text' | 'clipboard-status' }>,
  ): void {
    const pending = this.pendingState();
    if (pending?.transferId !== message.transferId) return;
    this.lastInSequence = message.sequence;
    this.remember(message.transferId);
    this.finish();
    if (message.type === 'clipboard-text') {
      if (pending.kind !== 'receive') return;
      this.receivedText = message.text;
      this.receivedCharacters.set(message.text.length);
      this.notice.set({
        tone: 'info',
        text: 'Remote text received. Choose Copy to my clipboard to use it.',
      });
      return;
    }
    if (message.outcome === 'delivered') {
      this.notice.set(
        pending.kind === 'send'
          ? {
              tone: 'info',
              text: `Sent ${String(pending.characters)} characters to the other computer's clipboard.`,
            }
          : { tone: 'error', text: OUTCOME_TEXT.failed },
      );
    } else this.fail(OUTCOME_TEXT[message.outcome]);
  }

  // ----- Internals -------------------------------------------------------------------------

  private forwardToHelper(
    session: ActiveControlSession,
    transferId: string,
    kind: 'write' | 'read',
    characters: number,
    text?: string,
  ): void {
    const message: HelperClipboardWrite | HelperClipboardRead =
      kind === 'write' && text !== undefined
        ? {
            type: 'helper-clipboard-write',
            controlSessionId: session.controlSessionId,
            surfaceId: session.surfaceId,
            transferId,
            text,
          }
        : {
            type: 'helper-clipboard-read',
            controlSessionId: session.controlSessionId,
            surfaceId: session.surfaceId,
            transferId,
          };
    this.helperPending.set(transferId, {
      kind,
      sessionId: session.controlSessionId,
      surfaceId: session.surfaceId,
      characters,
    });
    if (!this.relay?.(message)) {
      this.forgetHelperOperation(transferId);
      this.reply(session, transferId, 'unavailable');
      return;
    }
    this.helperTimers.set(
      transferId,
      setTimeout(() => {
        if (!this.helperPending.has(transferId)) return;
        this.forgetHelperOperation(transferId);
        const current = this.controlledSession();
        if (current) this.reply(current, transferId, 'failed');
      }, HELPER_ANSWER_TIMEOUT_MS),
    );
  }

  private reply(
    session: ActiveControlSession,
    transferId: string,
    outcome: ClipboardOutcome,
  ): void {
    this.send({ type: 'clipboard-status', ...this.envelope(session), transferId, outcome });
  }

  private envelope(session: ActiveControlSession): {
    protocolVersion: typeof CLIPBOARD_PROTOCOL_VERSION;
    controlSessionId: string;
    surfaceId: string;
    sequence: number;
  } {
    return {
      protocolVersion: CLIPBOARD_PROTOCOL_VERSION,
      controlSessionId: session.controlSessionId,
      surfaceId: session.surfaceId,
      sequence: ++this.outSequence,
    };
  }

  private send(message: ClipboardMessage): boolean {
    if (this.channel?.state !== 'open') return false;
    try {
      this.channel.sendText(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private controllerSession(): ActiveControlSession | null {
    return this.available() ? this.control.session() : null;
  }

  private controlledSession(): ActiveControlSession | null {
    const session = this.control.session();
    return session?.role === 'controlled' && session.scopes.includes('clipboard') ? session : null;
  }

  private begin(pending: Pending): void {
    this.finish();
    this.pendingState.set(pending);
    this.pendingTimer = setTimeout(() => {
      if (this.pendingState()?.transferId !== pending.transferId) return;
      this.finish();
      this.fail('The other computer did not answer. Nothing was changed.');
    }, CLIPBOARD_OPERATION_TIMEOUT_MS);
  }

  private finish(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingState.set(null);
  }

  private fail(text: string): void {
    this.notice.set({ tone: 'error', text });
  }

  private remember(transferId: string): void {
    this.seen.push(transferId);
    if (this.seen.length > REMEMBERED_TRANSFERS) this.seen.shift();
  }

  private clearApproval(): void {
    if (this.approvalTimer) clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
    this.incomingRead.set(null);
  }

  private forgetHelperOperation(transferId: string): void {
    this.helperPending.delete(transferId);
    const timer = this.helperTimers.get(transferId);
    if (timer) clearTimeout(timer);
    this.helperTimers.delete(transferId);
  }

  private resetState(): void {
    this.finish();
    this.clearApproval();
    for (const transferId of [...this.helperPending.keys()]) this.forgetHelperOperation(transferId);
    this.discardReceived();
    this.notice.set(null);
    this.peerWrote.set(null);
    this.outSequence = 0;
    this.lastInSequence = -1;
    this.lastAcceptedAt = null;
    this.seen.length = 0;
  }

  private detachChannel(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.channel = null;
    this.channelOpen.set(false);
    if (this.control.session()) this.fail('The connection to the other computer closed.');
  }
}

function helperOutcome(outcome: HelperClipboardResult['outcome']): ClipboardOutcome {
  switch (outcome) {
    case 'unavailable':
    case 'empty':
    case 'too-large':
    case 'denied':
    case 'failed':
      return outcome;
    case 'ok':
      return 'failed';
  }
}
