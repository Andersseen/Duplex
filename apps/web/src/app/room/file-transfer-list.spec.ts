import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { userEvent } from '@testing-library/user-event';
import { CallSessionService } from '../services/call-session.service';
import type { TransferView } from '../services/file-transfer.service';
import { FileTransferList } from './file-transfer-list';

function transfer(overrides: Partial<TransferView>): TransferView {
  return {
    id: 't1',
    direction: 'receiving',
    name: 'report.pdf',
    size: 2048,
    bytes: 0,
    state: 'offered',
    ...overrides,
  };
}

async function renderList(transfers: TransferView[]) {
  const fileTransfers = {
    transfers: signal(transfers),
    accept: vi.fn(),
    decline: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    downloadUrl: vi.fn().mockReturnValue('blob:test'),
  };
  await render(FileTransferList, {
    providers: [{ provide: CallSessionService, useValue: { fileTransfers } }],
  });
  return fileTransfers;
}

describe('FileTransferList', () => {
  it('requires the receiver to accept or decline an offer', async () => {
    const user = userEvent.setup();
    const transfers = await renderList([transfer({})]);

    expect(screen.getByText('Peer wants to send')).toBeVisible();
    expect(screen.getByText('report.pdf · 2 KB')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(transfers.decline).toHaveBeenCalledWith('t1');
    expect(transfers.accept).toHaveBeenCalledWith('t1');
  });

  it('shows progress for an active transfer and allows cancelling it', async () => {
    const user = userEvent.setup();
    const transfers = await renderList([
      transfer({ state: 'transferring', direction: 'sending', bytes: 512, size: 2048 }),
    ]);

    expect(
      screen.getByRole('progressbar', { name: 'Transfer progress for report.pdf' }),
    ).toBeVisible();
    expect(screen.getByText('25%')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(transfers.cancel).toHaveBeenCalledWith('t1');
  });

  it('offers a download for a received file and lets the user dismiss it', async () => {
    const user = userEvent.setup();
    const transfers = await renderList([transfer({ state: 'completed', size: 3 * 1024 * 1024 })]);

    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
      'report.pdf',
    );
    expect(screen.getByText('report.pdf · 3.0 MB')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(transfers.dismiss).toHaveBeenCalledWith('t1');
  });

  it('reports failures and pending states without offering actions that cannot work', async () => {
    await renderList([
      transfer({ id: 'a', state: 'failed', error: 'Connection lost.' }),
      transfer({ id: 'b', direction: 'sending', state: 'queued' }),
      transfer({ id: 'c', direction: 'sending', state: 'waiting-for-acceptance' }),
    ]);

    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost.');
    expect(screen.getByText('Queued')).toBeVisible();
    expect(screen.getByText('Waiting for acceptance…')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });
});
