import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { VoltCard, VoltNativeButton, VoltProgress } from '@voltui/components';
import { CallSessionService } from '../services/call-session.service';

/** Transfer rows and consent actions; bytes and state live in FileTransferService. */
@Component({
  selector: 'dx-file-transfer-list',
  imports: [VoltCard, VoltNativeButton, VoltProgress],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="space-y-3" aria-label="File transfers">
      @for (transfer of transfers.transfers(); track transfer.id) {
        <volt-card class="p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-medium">
                {{ transfer.direction === 'sending' ? 'Sending' : 'Peer wants to send' }}
              </p>
              <p class="truncate text-sm text-muted-foreground">
                {{ transfer.name }} · {{ formatSize(transfer.size) }}
              </p>
            </div>
            @if (transfer.state === 'offered') {
              <div class="flex gap-2">
                <button voltButton variant="outline" (click)="transfers.decline(transfer.id)">
                  Decline
                </button>
                <button voltButton variant="solid" (click)="transfers.accept(transfer.id)">
                  Accept
                </button>
              </div>
            } @else if (transfer.state === 'transferring') {
              <button voltButton variant="outline" (click)="transfers.cancel(transfer.id)">
                Cancel
              </button>
            } @else if (transfer.state === 'completed' && transfer.direction === 'receiving') {
              <div class="flex gap-2">
                <a
                  voltButton
                  variant="solid"
                  [href]="transfers.downloadUrl(transfer.id)"
                  [attr.download]="transfer.name"
                  >Download</a
                >
                <button voltButton variant="outline" (click)="transfers.dismiss(transfer.id)">
                  Dismiss
                </button>
              </div>
            } @else if (
              transfer.state !== 'queued' && transfer.state !== 'waiting-for-acceptance'
            ) {
              <button voltButton variant="outline" (click)="transfers.dismiss(transfer.id)">
                Dismiss
              </button>
            }
          </div>
          @if (transfer.state === 'transferring') {
            <volt-progress
              class="mt-3"
              [max]="transfer.size || 1"
              [value]="transfer.bytes"
              [attr.aria-label]="'Transfer progress for ' + transfer.name"
            ></volt-progress>
            <p class="mt-1 text-sm text-muted-foreground">{{ percent(transfer) }}%</p>
          } @else if (transfer.state === 'completed') {
            <p class="mt-2 text-sm text-success">Received</p>
          } @else if (transfer.error) {
            <p role="alert" class="mt-2 text-sm text-destructive">{{ transfer.error }}</p>
          } @else if (transfer.state === 'queued') {
            <p class="mt-2 text-sm text-muted-foreground">Queued</p>
          } @else if (transfer.state === 'waiting-for-acceptance') {
            <p class="mt-2 text-sm text-muted-foreground">Waiting for acceptance…</p>
          }
        </volt-card>
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
