import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type HelperStatus = 'not-connected' | 'connecting' | 'connected' | 'authorized' | 'error';
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

const STATUS_LABELS: Record<HelperStatus, string> = {
  'not-connected': 'Not connected',
  connecting: 'Connecting to Duplex…',
  connected: 'Connected to Duplex call · Waiting for control permission',
  authorized: 'Control session authorized',
  error: 'Could not connect to Duplex.',
};

@Component({
  selector: 'dx-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'shell' },
  styles: `
    .shell {
      display: flex;
      min-height: 100dvh;
      flex-direction: column;
      justify-content: center;
      gap: 0.75rem;
      box-sizing: border-box;
      padding: 2rem;
      max-width: 38rem;
      margin: auto;
    }
    h1 {
      margin: 0;
      font-size: 2rem;
      letter-spacing: -0.02em;
    }
    p {
      margin: 0;
      opacity: 0.75;
    }
    .status {
      margin-top: 1rem;
      opacity: 1;
      font-weight: 500;
    }
    textarea {
      min-height: 7rem;
      resize: vertical;
    }
  `,
  template: `
    <h1>Duplex</h1>
    <p>Remote Control Helper</p>
    <p class="status" role="status">{{ statusLabel() }}</p>
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
      <button type="button" [disabled]="!pairingCode().trim()" (click)="connect()">Connect</button>
    }
    @if (status() === 'connecting' || status() === 'connected' || status() === 'authorized') {
      @if (session(); as activeSession) {
        <section aria-label="Authorized control session">
          <p>{{ activeSession.scopes.join(' · ') }}</p>
          <p>Expires in {{ expiryLabel() }}</p>
        </section>
      }
      <p class="note">Native mouse and keyboard input is not implemented yet.</p>
      <button type="button" (click)="disconnect()">Disconnect</button>
    }
  `,
})
export class App implements OnDestroy {
  protected readonly status = signal<HelperStatus>('not-connected');
  protected readonly pairingCode = signal('');
  protected readonly error = signal('');
  protected readonly session = signal<SessionMetadata | null>(null);
  protected readonly remainingSeconds = signal(0);
  protected readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
  protected readonly expiryLabel = computed(() => {
    const seconds = this.remainingSeconds();
    return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
  });
  private unlisten: (() => void) | null = null;
  private expiryInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    void listen<HelperStatusEvent>('helper-state', ({ payload }) => {
      this.status.set(payload.status);
      if (
        payload.status === 'authorized' &&
        payload.details &&
        'controlSessionId' in payload.details
      ) {
        this.session.set(payload.details);
        this.startExpiryCountdown(payload.details.expiresAt);
      } else if (payload.status !== 'authorized') {
        this.session.set(null);
        this.stopExpiryCountdown();
      }
      this.error.set(
        payload.status === 'error' && payload.details && 'message' in payload.details
          ? (payload.details.message ??
              'Could not connect to Duplex. Check the pairing code and network.')
          : '',
      );
    })
      .then((unlisten) => {
        this.unlisten = unlisten;
      })
      .catch(() => undefined);
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

  ngOnDestroy(): void {
    this.unlisten?.();
    this.stopExpiryCountdown();
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
