import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CallSessionService } from '../services/call-session.service';
import { ControlButton } from '../ui/control-button';

/** Transfer rows and consent actions; bytes and state live in FileTransferService. */
@Component({
  selector: 'dx-file-transfer-list',
  imports: [ControlButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="space-y-3" aria-label="File transfers">
      @for (transfer of transfers.transfers(); track transfer.id) {
        <article class="rounded-2xl border border-line bg-surface p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-medium">
                {{ transfer.direction === 'sending' ? 'Sending' : 'Peer wants to send' }}
              </p>
              <p class="truncate text-sm text-ink-muted">
                {{ transfer.name }} · {{ formatSize(transfer.size) }}
              </p>
            </div>
            @if (transfer.state === 'offered') {
              <div class="flex gap-2">
                <dx-control-button label="Decline" (activated)="transfers.decline(transfer.id)" />
                <dx-control-button
                  label="Accept"
                  variant="primary"
                  (activated)="transfers.accept(transfer.id)"
                />
              </div>
            } @else if (transfer.state === 'transferring') {
              <dx-control-button label="Cancel" (activated)="transfers.cancel(transfer.id)" />
            } @else if (transfer.state === 'completed' && transfer.direction === 'receiving') {
              <div class="flex gap-2">
                <a
                  class="inline-flex min-h-11 items-center rounded-full bg-ink px-5 text-sm font-medium text-ink-inverse"
                  [href]="transfers.downloadUrl(transfer.id)"
                  [attr.download]="transfer.name"
                  >Download</a
                >
                <dx-control-button label="Dismiss" (activated)="transfers.dismiss(transfer.id)" />
              </div>
            } @else if (
              transfer.state !== 'queued' && transfer.state !== 'waiting-for-acceptance'
            ) {
              <dx-control-button label="Dismiss" (activated)="transfers.dismiss(transfer.id)" />
            }
          </div>
          @if (transfer.state === 'transferring') {
            <progress
              class="mt-3 h-2 w-full accent-accent"
              [max]="transfer.size || 1"
              [value]="transfer.bytes"
              [attr.aria-label]="'Transfer progress for ' + transfer.name"
            ></progress>
            <p class="mt-1 text-sm text-ink-muted">{{ percent(transfer) }}%</p>
          } @else if (transfer.state === 'completed') {
            <p class="mt-2 text-sm text-ok">Received</p>
          } @else if (transfer.error) {
            <p role="alert" class="mt-2 text-sm text-danger">{{ transfer.error }}</p>
          } @else if (transfer.state === 'queued') {
            <p class="mt-2 text-sm text-ink-muted">Queued</p>
          } @else if (transfer.state === 'waiting-for-acceptance') {
            <p class="mt-2 text-sm text-ink-muted">Waiting for acceptance…</p>
          }
        </article>
      }
    </section>
  `,
})
export class FileTransferList {
  protected readonly transfers = inject(CallSessionService).fileTransfers;

  protected percent(transfer: { bytes: number; size: number }): number {
    return Math.round((transfer.bytes / (transfer.size || 1)) * 100);
  }

  protected formatSize(size: number): string {
    return size >= 1024 * 1024
      ? `${(size / 1024 / 1024).toFixed(1)} MB`
      : `${(size / 1024).toFixed(0)} KB`;
  }
}
