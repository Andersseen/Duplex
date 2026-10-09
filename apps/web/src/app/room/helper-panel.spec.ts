import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { userEvent } from '@testing-library/user-event';
import { CallSessionService } from '../services/call-session.service';
import { HelperPanel } from './helper-panel';

function fakeSession() {
  return {
    helperConnected: signal(false),
    helperPairingCode: signal<string | null>(null),
    control: { localAvailableScopes: signal<string[]>([]) },
    createHelperPairingCode: vi.fn(),
    copyHelperPairingCode: vi.fn().mockResolvedValue(true),
  };
}

async function renderPanel(fake = fakeSession()) {
  await render(HelperPanel, { providers: [{ provide: CallSessionService, useValue: fake }] });
  return fake;
}

describe('HelperPanel', () => {
  it('starts disconnected and creates a pairing code on request', async () => {
    const user = userEvent.setup();
    const fake = await renderPanel();

    expect(screen.getByText('Not connected')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Create pairing code' }));

    expect(fake.createHelperPairingCode).toHaveBeenCalledOnce();
  });

  it('shows the pairing code with its expiry and confirms a copy', async () => {
    const user = userEvent.setup();
    const fake = fakeSession();
    fake.helperPairingCode.set('pairing-code-for-test');
    await renderPanel(fake);

    expect(screen.getByLabelText('Helper pairing code')).toHaveValue('pairing-code-for-test');
    expect(screen.getByText(/expires in 2 minutes/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Copy helper code' }));

    expect(fake.copyHelperPairingCode).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('keeps the copy label when the clipboard is unavailable', async () => {
    const user = userEvent.setup();
    const fake = fakeSession();
    fake.helperPairingCode.set('pairing-code-for-test');
    fake.copyHelperPairingCode.mockResolvedValue(false);
    await renderPanel(fake);

    await user.click(screen.getByRole('button', { name: 'Copy helper code' }));

    expect(screen.getByRole('button', { name: 'Copy helper code' })).toBeVisible();
  });

  it('never renders the pairing code once the helper is connected', async () => {
    const fake = fakeSession();
    fake.helperConnected.set(true);
    fake.helperPairingCode.set('pairing-code-for-test');
    await renderPanel(fake);

    expect(screen.getByRole('status')).toHaveTextContent('Helper connected');
    expect(screen.queryByLabelText('Helper pairing code')).not.toBeInTheDocument();
    expect(screen.getByText(/Pointer control is not ready/)).toBeVisible();
  });

  it('reports when pointer control is ready', async () => {
    const fake = fakeSession();
    fake.helperConnected.set(true);
    fake.control.localAvailableScopes.set(['pointer']);
    await renderPanel(fake);

    expect(screen.getByText(/Pointer control is ready/)).toBeVisible();
    expect(screen.getByText(/Keyboard is not available yet/)).toBeVisible();
  });
});
