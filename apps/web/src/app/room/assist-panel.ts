import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MAX_CLIPBOARD_TEXT_BYTES } from '@duplex/protocol';
import type { ControlScope } from '@duplex/protocol';
import { VoltCard, VoltCheckbox, VoltNativeButton } from '@voltui/components';
import { CallSessionService } from '../services/call-session.service';

const SCOPE_LABELS: Record<ControlScope, string> = {
  pointer: 'Pointer',
  keyboard: 'Keyboard',
  clipboard: 'Clipboard text',
};

/** What each scope lets the other person do, shown before anything is granted. */
const SCOPE_DESCRIPTIONS: Record<ControlScope, string> = {
  pointer: 'Move the mouse, click and scroll on the shared screen.',
  keyboard: 'Type on the shared computer using a limited set of keys.',
  clipboard: `Put text on the shared computer's clipboard, and ask to copy text from it. Plain text only, up to ${String(MAX_CLIPBOARD_TEXT_BYTES / 1024)} KiB. You approve every read of your clipboard.`,
};

/** Assist permission and session UI. Authorization decisions stay in ControlService. */
@Component({
  selector: 'dx-assist-panel',
  imports: [VoltCard, VoltCheckbox, VoltNativeButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section role="region" aria-label="Assist control">
      <volt-card class="p-4">
        <h2 class="mb-2 text-sm font-semibold tracking-tight">Assist</h2>
        @if (session.control.session(); as controlSession) {
          <p role="status" class="font-medium">
            {{
              controlSession.role === 'controller'
                ? 'Control granted'
                : 'Peer has control permission'
            }}
          </p>
          <p class="mt-1 text-sm">
            {{ controlSession.scopes.join(' · ') }} · Expires in
            {{ session.control.remainingSeconds() }} seconds
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{
              controlSession.role === 'controller'
                ? 'Control is live for the scopes shown above. Focus the shared screen to type.'
                : 'Your peer can control only the scopes shown above.'
            }}
          </p>
          @if (clipboard.available()) {
            <div role="group" aria-label="Clipboard text" class="mt-3 border-t border-border pt-3">
              <p class="text-sm font-medium">Clipboard text</p>
              <p class="mt-1 text-xs text-muted-foreground">
                Nothing is shared until you choose. Your browser may ask permission to read your
                clipboard.
              </p>
              <div class="mt-2 flex flex-wrap gap-2">
                <button
                  voltButton
                  variant="outline"
                  [disabled]="clipboard.busy() || !clipboard.canReadLocal()"
                  (click)="clipboard.sendLocalClipboard()"
                >
                  Send my clipboard text
                </button>
                <button
                  voltButton
                  variant="outline"
                  [disabled]="clipboard.busy() || !clipboard.canWriteLocal()"
                  (click)="clipboard.requestRemoteClipboard()"
                >
                  Get remote clipboard text
                </button>
              </div>
              @if (!clipboard.canReadLocal() || !clipboard.canWriteLocal()) {
                <p class="mt-2 text-xs text-muted-foreground">
                  This browser limits clipboard access; some clipboard actions are unavailable.
                </p>
              }
              @if (clipboard.receivedCharacters(); as received) {
                <p class="mt-2 text-sm">Remote text ready ({{ received }} characters).</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <button voltButton variant="solid" (click)="clipboard.copyReceived()">
                    Copy to my clipboard
                  </button>
                  <button voltButton variant="outline" (click)="clipboard.discardReceived()">
                    Discard
                  </button>
                </div>
              }
            </div>
          }
          @if (
            controlSession.role === 'controlled' && controlSession.scopes.includes('clipboard')
          ) {
            @if (clipboard.incomingRead()) {
              <div
                role="alertdialog"
                aria-label="Clipboard read request"
                class="mt-3 border-t border-border pt-3"
              >
                <p class="font-medium">Peer asks to copy the text on your clipboard</p>
                <p class="mt-1 text-sm">
                  Share it once only if you expect this. Nothing else on your computer is shared.
                </p>
                <div class="mt-3 flex gap-2">
                  <button voltButton variant="outline" (click)="clipboard.declineRead()">
                    Decline
                  </button>
                  <button voltButton variant="solid" (click)="clipboard.approveRead()">
                    Share once
                  </button>
                </div>
              </div>
            }
            @if (clipboard.peerWrote(); as wrote) {
              <p role="status" class="mt-3 text-sm">
                Your peer put {{ wrote.characters }} characters of text on your clipboard.
              </p>
            }
          }
          @if (clipboard.notice(); as notice) {
            <p
              class="mt-3 text-sm"
              [class.text-destructive]="notice.tone === 'error'"
              [attr.role]="notice.tone === 'error' ? 'alert' : 'status'"
            >
              {{ notice.text }}
            </p>
          }
          <div class="mt-3">
            <button voltButton variant="outline" (click)="session.control.release()">
              {{ controlSession.role === 'controller' ? 'Release control' : 'Stop control' }}
            </button>
          </div>
        } @else if (session.control.incomingRequest(); as request) {
          <div role="alertdialog" aria-label="Control permission request">
            <p class="font-medium">Peer wants to control this screen</p>
            <p class="mt-1 text-sm">Requested: {{ request.scopes.join(' · ') }}</p>
            <p class="mt-1 text-sm">Access expires automatically.</p>
            <fieldset class="mt-2">
              <legend class="text-sm font-medium">Allow</legend>
              @for (scope of request.scopes; track scope) {
                <div class="mt-1 flex items-start gap-2 text-sm">
                  <volt-checkbox
                    class="mt-1"
                    [id]="'grant-' + request.requestId + '-' + scope"
                    [checked]="grantChosen(request.requestId, scope)"
                    (checkedChange)="chooseGrant(request.requestId, scope, $event)"
                  />
                  <label [for]="'grant-' + request.requestId + '-' + scope">
                    <span class="font-medium">{{ label(scope) }}</span>
                    <span class="block text-xs text-muted-foreground">{{
                      description(scope)
                    }}</span>
                  </label>
                </div>
              }
            </fieldset>
            <div class="mt-3 flex gap-2">
              <button voltButton variant="outline" (click)="session.control.reject()">
                Reject
              </button>
              <button
                voltButton
                variant="solid"
                [disabled]="grantedScopes(request).length === 0"
                (click)="session.control.allow(grantedScopes(request))"
              >
                Allow
              </button>
            </div>
          </div>
        } @else if (session.control.canRequest()) {
          <p class="font-medium">Assist is available for this shared screen.</p>
          <p class="mt-1 text-sm">
            Available: {{ session.control.peerAvailableScopes().join(' · ') }}
          </p>
          <fieldset class="mt-2">
            <legend class="text-sm font-medium">Request</legend>
            @for (scope of session.control.peerAvailableScopes(); track scope) {
              <div class="mt-1 flex items-start gap-2 text-sm">
                <volt-checkbox
                  class="mt-1"
                  [id]="'request-' + scope"
                  [checked]="requestChosen(scope)"
                  (checkedChange)="chooseRequest(scope, $event)"
                />
                <label [for]="'request-' + scope">
                  <span class="font-medium">{{ label(scope) }}</span>
                  <span class="block text-xs text-muted-foreground">{{ description(scope) }}</span>
                </label>
              </div>
            }
          </fieldset>
          <div class="mt-3">
            <button
              voltButton
              variant="solid"
              [disabled]="
                session.control.state() === 'requesting' || requestedScopes().length === 0
              "
              (click)="session.control.requestControl(requestedScopes())"
            >
              {{ session.control.state() === 'requesting' ? 'Request sent' : 'Request control' }}
            </button>
          </div>
        } @else {
          <p class="text-sm text-muted-foreground">
            Remote control unavailable until the screen sharer pairs Duplex Helper.
          </p>
        }
      </volt-card>
    </section>
  `,
})
export class AssistPanel {
  protected readonly session = inject(CallSessionService);
  protected readonly clipboard = this.session.clipboard;
  /** Explicit checkbox choices; clipboard is never chosen unless the person ticks it. */
  private readonly choices = signal<Readonly<Record<string, boolean>>>({});

  protected label(scope: ControlScope): string {
    return SCOPE_LABELS[scope];
  }

  protected description(scope: ControlScope): string {
    return SCOPE_DESCRIPTIONS[scope];
  }

  protected requestChosen(scope: ControlScope): boolean {
    return this.choices()[`out:${scope}`] ?? scope !== 'clipboard';
  }

  protected requestedScopes(): ControlScope[] {
    return this.session.control.peerAvailableScopes().filter((scope) => this.requestChosen(scope));
  }

  protected chooseRequest(scope: ControlScope, checked: boolean): void {
    this.choose(`out:${scope}`, checked);
  }

  protected grantChosen(requestId: string, scope: ControlScope): boolean {
    return this.choices()[`in:${requestId}:${scope}`] ?? scope !== 'clipboard';
  }

  protected grantedScopes(request: {
    readonly requestId: string;
    readonly scopes: readonly ControlScope[];
  }): ControlScope[] {
    return request.scopes.filter((scope) => this.grantChosen(request.requestId, scope));
  }

  protected chooseGrant(requestId: string, scope: ControlScope, checked: boolean): void {
    this.choose(`in:${requestId}:${scope}`, checked);
  }

  private choose(key: string, checked: boolean): void {
    this.choices.update((current) => ({ ...current, [key]: checked }));
  }
}
