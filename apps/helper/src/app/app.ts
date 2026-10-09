import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type HelperStatus = 'not-connected' | 'connecting' | 'connected' | 'authorized' | 'error';
type Accessibility = 'unsupported' | 'not-granted' | 'granted';
interface SessionMetadata {
  controlSessionId: string;
  surfaceId: string;
  scopes: readonly ('pointer' | 'keyboard')[];
  expiresAt: number;
}
interface HelperStatusEvent {
  status: HelperStatus;
  details?: SessionMetadata | { message?: string } | null;
}
interface DisplayInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  selected: boolean;
}
/** Local-only native readiness. None of this is ever sent to the remote participant. */
interface NativeStatus {
  platform: 'macos' | 'unsupported';
  accessibility: Accessibility;
  displays: readonly DisplayInfo[];
  selectedDisplayId: number | null;
  pointerReady: boolean;
  keyboardAvailable: boolean;
  sessionActive: boolean;
}

const STATUS_LABELS: Record<HelperStatus, string> = {
  'not-connected': 'Not connected',
  connecting: 'Connecting to Duplex…',
  connected: 'Connected to Duplex call · Waiting for control permission',
  authorized: 'Peer may control this Mac',
  error: 'Could not connect to Duplex.',
};

@Component({
  selector: 'dx-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:focus)': 'refreshNative()' },
  styles: `
    :host {
      display: flex;
      min-height: 100dvh;
      flex-direction: column;
      justify-content: center;
      gap: 0.75rem;
      box-sizing: border-box;
      padding: 1.5rem 2rem;
      max-width: 38rem;
      margin: auto;
    }
    header {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }
    h1 {
      margin: 0;
      font-size: 1.75rem;
      letter-spacing: -0.02em;
    }
    h2 {
      margin: 0;
      font-size: 0.95rem;
    }
    p {
      margin: 0;
      color: var(--dx-muted);
    }
    .status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.25rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--dx-line);
      border-radius: 999px;
      color: var(--dx-ink);
      font-weight: 500;
    }
    .status::before {
      content: '';
      width: 0.5rem;
      height: 0.5rem;
      flex: none;
      border-radius: 50%;
      background: var(--dx-muted);
    }
    .status[data-status='connected']::before {
      background: var(--dx-ok);
    }
    .status[data-status='authorized']::before {
      background: var(--dx-warn);
    }
    .status[data-status='error']::before {
      background: var(--dx-danger);
    }
    section {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--dx-line);
      border-radius: 0.75rem;
      background: var(--dx-surface);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .badge {
      font-weight: 600;
    }
    label {
      font-size: 0.9rem;
    }
    textarea {
      min-height: 7rem;
      resize: vertical;
      padding: 0.5rem;
      border: 1px solid var(--dx-line);
      border-radius: 0.5rem;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    fieldset {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      margin: 0;
      padding: 0;
      border: 0;
    }
    button {
      min-height: 2.25rem;
      padding: 0.375rem 1rem;
      border: 1px solid var(--dx-line);
      border-radius: 999px;
      background: var(--dx-surface);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    button.primary {
      border-color: transparent;
      background: var(--dx-ink);
      color: var(--dx-surface);
    }
    button.danger {
      border-color: transparent;
      background: var(--dx-danger-bg);
      color: #fff;
    }
    :focus-visible {
      outline: 2px solid var(--dx-accent);
      outline-offset: 2px;
    }
  `,
  template: `
    <header>
      <h1>Duplex</h1>
      <p>Remote Control Helper</p>
    </header>
    <p class="status" role="status" [attr.data-status]="status()">{{ statusLabel() }}</p>
    @if (status() === 'not-connected' || status() === 'error') {
      <label for="pairing-code">Paste pairing code</label>
      <textarea
        id="pairing-code"
        aria-label="Paste pairing code"
        [value]="pairingCode()"
        (input)="setPairingCode($event)"
        autocomplete="off"
        spellcheck="false"
      ></textarea>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      <button type="button" class="primary" [disabled]="!pairingCode().trim()" (click)="connect()">
        Connect
      </button>
    }
    @if (native(); as state) {
      <section aria-label="Native pointer control">
        @if (state.platform === 'unsupported') {
          <p>Native pointer control is available on macOS only. Pairing still works.</p>
        } @else {
          <div class="row">
            <h2>Accessibility</h2>
            @if (state.accessibility === 'granted') {
              <span class="badge">Granted</span>
            } @else {
              <button type="button" (click)="requestAccessibility()">Enable Accessibility</button>
            }
          </div>
          @if (state.accessibility !== 'granted') {
            <p>
              Allow Duplex Helper in System Settings › Privacy &amp; Security › Accessibility, then
              re-check.
              <button type="button" (click)="refreshNative()">Re-check</button>
            </p>
          }
          <fieldset>
            <legend><h2>Control target</h2></legend>
            @for (display of state.displays; track display.id) {
              <label>
                <input
                  type="radio"
                  name="control-display"
                  [checked]="display.selected"
                  (change)="selectDisplay(display.id)"
                />
                {{ display.name }} — {{ display.width }} × {{ display.height }}
              </label>
            } @empty {
              <p>No active display found.</p>
            }
            @if (state.displays.length > 1 && state.selectedDisplayId === null) {
              <p>Choose the display your peer may control.</p>
            }
          </fieldset>
          <div class="row">
            <h2>Pointer control</h2>
            <span class="badge">{{ pointerLabel() }}</span>
          </div>
        }
        <div class="row">
          <h2>Keyboard control</h2>
          <span class="badge">Not implemented yet</span>
        </div>
      </section>
    }
    @if (status() === 'connecting' || status() === 'connected' || status() === 'authorized') {
      @if (session(); as activeSession) {
        <section aria-label="Authorized control session">
          <h2>Peer may control this Mac</h2>
          <p>{{ sessionScopes() }}</p>
          <p>Expires in {{ expiryLabel() }}</p>
          <button type="button" class="danger" (click)="stopControl()">Stop control</button>
        </section>
      }
      <button type="button" (click)="disconnect()">Disconnect</button>
    }
  `,
})
export class App implements OnDestroy {
  protected readonly status = signal<HelperStatus>('not-connected');
  protected readonly pairingCode = signal('');
  protected readonly error = signal('');
  protected readonly session = signal<SessionMetadata | null>(null);
  protected readonly native = signal<NativeStatus | null>(null);
  protected readonly remainingSeconds = signal(0);
  protected readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
  protected readonly expiryLabel = computed(() => {
    const seconds = this.remainingSeconds();
    return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
  });
  /** Only pointer is executable; a stray keyboard scope is never presented as working. */
  protected readonly sessionScopes = computed(() =>
    this.session()?.scopes.includes('pointer') ? 'Pointer' : 'No supported scope',
  );
  protected readonly pointerLabel = computed(() => {
    const state = this.native();
    if (!state || state.platform === 'unsupported') return 'Unavailable';
    if (state.sessionActive) return 'In use';
    if (state.pointerReady) return 'Ready';
    if (state.accessibility !== 'granted') return 'Enable Accessibility first';
    return 'Choose a display';
  });
  private unlisten: (() => void)[] = [];
  private destroyed = false;
  private expiryInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.subscribe('helper-state', (payload) => {
      const { status, details } = payload as HelperStatusEvent;
      this.status.set(status);
      if (status === 'authorized' && details && 'controlSessionId' in details) {
        this.session.set(details);
        this.startExpiryCountdown(details.expiresAt);
      } else if (status !== 'authorized') {
        this.session.set(null);
        this.stopExpiryCountdown();
      }
      this.error.set(
        status === 'error' && details && 'message' in details
          ? (details.message ?? 'Could not connect to Duplex. Check the pairing code and network.')
          : '',
      );
    });
    this.subscribe('native-state', (state) => {
      this.native.set(state as NativeStatus);
    });
    void this.refreshNative();
  }

  protected setPairingCode(event: Event): void {
    this.pairingCode.set((event.target as HTMLTextAreaElement).value);
    this.error.set('');
  }

  protected async connect(): Promise<void> {
    const code = this.pairingCode().trim();
    if (!code) return;
    this.pairingCode.set('');
    this.error.set('');
    this.status.set('connecting');
    try {
      await invoke('connect_helper', { pairingCode: code });
    } catch {
      this.status.set('error');
      this.error.set('Could not connect to Duplex. Check the pairing code and network.');
    }
  }

  protected async disconnect(): Promise<void> {
    try {
      await invoke('disconnect_helper');
    } catch {
      /* UI still returns to a disconnected state. */
    }
    this.status.set('not-connected');
    this.session.set(null);
    this.stopExpiryCountdown();
  }

  /** Explicit local action: the only way an Accessibility prompt is ever shown. */
  protected async requestAccessibility(): Promise<void> {
    await this.command('request_accessibility');
  }

  /** Cheap re-check, run on window focus and from the Re-check button — never on a timer. */
  protected async refreshNative(): Promise<void> {
    await this.command('refresh_accessibility_status');
  }

  protected async selectDisplay(displayId: number): Promise<void> {
    await this.command('select_display', { displayId });
  }

  /** Local emergency stop. The helper stays paired and connected. */
  protected async stopControl(): Promise<void> {
    await this.command('stop_control');
    this.session.set(null);
    this.stopExpiryCountdown();
    if (this.status() === 'authorized') this.status.set('connected');
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const unlisten of this.unlisten) unlisten();
    this.unlisten = [];
    this.stopExpiryCountdown();
  }

  private async command(name: string, args?: Record<string, unknown>): Promise<void> {
    try {
      const state = await invoke<NativeStatus | undefined>(name, args);
      if (state) this.native.set(state);
    } catch {
      /* Native state stays as it was; the next event or re-check corrects it. */
    }
  }

  private subscribe(name: string, handler: (payload: unknown) => void): void {
    listen(name, ({ payload }) => {
      handler(payload);
    })
      .then((unlisten) => {
        if (this.destroyed) unlisten();
        else this.unlisten.push(unlisten);
      })
      .catch(() => undefined);
  }

  private startExpiryCountdown(expiresAt: number): void {
    this.stopExpiryCountdown();
    const update = (): void => {
      this.remainingSeconds.set(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    };
    update();
    this.expiryInterval = setInterval(update, 1000);
  }

  private stopExpiryCountdown(): void {
    if (this.expiryInterval) clearInterval(this.expiryInterval);
    this.expiryInterval = null;
    this.remainingSeconds.set(0);
  }
}
