import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { VoltCard, VoltNativeButton, VoltTextarea } from '@voltui/components';
import { CallSessionService } from '../services/call-session.service';

/** Pairing UI for the native Duplex Helper; all state lives in CallSessionService. */
@Component({
  selector: 'dx-helper-panel',
  imports: [VoltCard, VoltNativeButton, VoltTextarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section role="region" aria-label="Duplex Helper">
      <volt-card class="p-4">
        <h2 class="mb-2 text-sm font-semibold tracking-tight">Duplex Helper</h2>
        @if (session.helperConnected()) {
          <p role="status" class="text-sm text-success">Helper connected</p>
          @if (session.control.localAvailableScopes().includes('pointer')) {
            <p class="mt-1 text-sm">Pointer control is ready. Keyboard is not available yet.</p>
          } @else {
            <p class="mt-1 text-sm text-muted-foreground">
              Pointer control is not ready. Share an entire screen, then enable Accessibility and
              choose a display in Duplex Helper (macOS only).
            </p>
          }
        } @else if (session.helperPairingCode()) {
          <p class="text-sm">Pairing code ready. It expires in 2 minutes.</p>
          <volt-textarea
            class="mt-2 font-mono text-xs"
            [rows]="4"
            readonly
            aria-label="Helper pairing code"
            [value]="session.helperPairingCode() ?? ''"
          ></volt-textarea>
          <div class="mt-2">
            <button voltButton variant="outline" (click)="copyCode()">
              {{ copied() ? 'Copied' : 'Copy helper code' }}
            </button>
          </div>
        } @else {
          <p class="text-sm text-muted-foreground">Not connected</p>
          <div class="mt-2">
            <button voltButton variant="outline" (click)="session.createHelperPairingCode()">
              Create pairing code
            </button>
          </div>
        }
      </volt-card>
    </section>
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
