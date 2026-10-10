import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CallSessionService } from '../services/call-session.service';
import { ControlButton } from '../ui/control-button';
import { Panel } from '../ui/panel';

/** Assist permission and session UI. Authorization decisions stay in ControlService. */
@Component({
  selector: 'dx-assist-panel',
  imports: [Panel, ControlButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dx-panel label="Assist control" heading="Assist">
      @if (session.control.session(); as controlSession) {
        <p role="status" class="font-medium">
          {{
            controlSession.role === 'controller' ? 'Control granted' : 'Peer has control permission'
          }}
        </p>
        <p class="mt-1 text-sm">
          {{ controlSession.scopes.join(' · ') }} · Expires in
          {{ session.control.remainingSeconds() }} seconds
        </p>
        <p class="mt-1 text-xs text-ink-muted">
          {{
            controlSession.role === 'controller'
              ? 'Control is live for the scopes shown above. Focus the shared screen to type.'
              : 'Your peer can control only the scopes shown above.'
          }}
        </p>
        <div class="mt-3">
          <dx-control-button
            [label]="controlSession.role === 'controller' ? 'Release control' : 'Stop control'"
            (activated)="session.control.release()"
          />
        </div>
      } @else if (session.control.incomingRequest(); as request) {
        <div role="alertdialog" aria-label="Control permission request">
          <p class="font-medium">Peer wants to control this screen</p>
          <p class="mt-1 text-sm">Requested: {{ request.scopes.join(' · ') }}</p>
          <p class="mt-1 text-sm">Access expires automatically.</p>
          <div class="mt-3 flex gap-2">
            <dx-control-button label="Reject" (activated)="session.control.reject()" />
            <dx-control-button
              label="Allow"
              variant="primary"
              (activated)="session.control.allow()"
            />
          </div>
        </div>
      } @else if (session.control.canRequest()) {
        <p class="font-medium">Assist is available for this shared screen.</p>
        <p class="mt-1 text-sm">
          Available: {{ session.control.peerAvailableScopes().join(' · ') }}
        </p>
        <div class="mt-3">
          <dx-control-button
            [label]="session.control.state() === 'requesting' ? 'Request sent' : 'Request control'"
            [disabled]="session.control.state() === 'requesting'"
            (activated)="session.control.requestControl()"
          />
        </div>
      } @else {
        <p class="text-sm text-ink-muted">
          Remote control unavailable until the screen sharer pairs Duplex Helper.
        </p>
      }
    </dx-panel>
  `,
})
export class AssistPanel {
  protected readonly session = inject(CallSessionService);
}
