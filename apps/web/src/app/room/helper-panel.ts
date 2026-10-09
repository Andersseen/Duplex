import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CallSessionService } from '../services/call-session.service';
import { ControlButton } from '../ui/control-button';
import { Panel } from '../ui/panel';

/** Pairing UI for the native Duplex Helper; all state lives in CallSessionService. */
@Component({
  selector: 'dx-helper-panel',
  imports: [Panel, ControlButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dx-panel label="Duplex Helper" heading="Duplex Helper">
      @if (session.helperConnected()) {
        <p role="status" class="text-sm text-ok">Helper connected</p>
        @if (session.control.localAvailableScopes().includes('pointer')) {
          <p class="mt-1 text-sm">Pointer control is ready. Keyboard is not available yet.</p>
        } @else {
          <p class="mt-1 text-sm text-ink-muted">
            Pointer control is not ready. Share an entire screen, then enable Accessibility and
            choose a display in Duplex Helper (macOS only).
          </p>
        }
      } @else if (session.helperPairingCode()) {
        <p class="text-sm">Pairing code ready. It expires in 2 minutes.</p>
        <textarea
          class="mt-2 w-full rounded-lg border border-line bg-transparent p-2 font-mono text-xs"
          readonly
          aria-label="Helper pairing code"
          [value]="session.helperPairingCode()"
        ></textarea>
        <div class="mt-2">
          <dx-control-button
            [label]="copied() ? 'Copied' : 'Copy helper code'"
            (activated)="copyCode()"
          />
        </div>
      } @else {
        <p class="text-sm text-ink-muted">Not connected</p>
        <div class="mt-2">
          <dx-control-button
            label="Create pairing code"
            (activated)="session.createHelperPairingCode()"
          />
        </div>
      }
    </dx-panel>
  `,
})
export class HelperPanel {
  protected readonly session = inject(CallSessionService);
  protected readonly copied = signal(false);

  protected async copyCode(): Promise<void> {
    this.copied.set(await this.session.copyHelperPairingCode());
    if (this.copied())
      setTimeout(() => {
        this.copied.set(false);
      }, 2000);
  }
}
