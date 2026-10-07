import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';

type HelperStatus = 'not-connected';

const STATUS_LABELS: Record<HelperStatus, string> = {
  'not-connected': 'Not connected to a call',
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
      gap: 0.5rem;
      box-sizing: border-box;
      padding: 2rem;
    }
    h1 {
      margin: 0;
      font-size: 2rem;
      letter-spacing: -0.02em;
    }
    p {
      margin: 0;
      opacity: 0.7;
    }
    .status {
      margin-top: 1rem;
      opacity: 1;
      font-weight: 500;
    }
  `,
  template: `
    <h1>Duplex</h1>
    <p>Remote Control Helper</p>
    <p class="status" role="status">{{ statusLabel() }}</p>
  `,
})
export class App {
  // The only state today. Call connection and consent flows arrive with remote control.
  protected readonly status = signal<HelperStatus>('not-connected');
  protected readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
}
