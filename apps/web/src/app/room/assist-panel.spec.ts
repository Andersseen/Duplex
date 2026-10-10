import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { userEvent } from '@testing-library/user-event';
import { CallSessionService } from '../services/call-session.service';
import { AssistPanel } from './assist-panel';

function fakeSession() {
  const control = {
    session: signal<{ role: 'controller' | 'controlled'; scopes: string[] } | null>(null),
    incomingRequest: signal<{ scopes: string[] } | null>(null),
    peerAvailableScopes: signal<string[]>([]),
    canRequest: signal(false),
    state: signal<'idle' | 'requesting'>('idle'),
    remainingSeconds: signal(42),
    requestControl: vi.fn(),
    allow: vi.fn(),
    reject: vi.fn(),
    release: vi.fn(),
  };
  return { control };
}

async function renderPanel(fake = fakeSession()) {
  await render(AssistPanel, {
    providers: [{ provide: CallSessionService, useValue: fake }],
  });
  return fake.control;
}

describe('AssistPanel', () => {
  it('explains why control is unavailable until the sharer pairs the helper', async () => {
    await renderPanel();

    expect(screen.getByText(/unavailable until the screen sharer pairs/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Request control' })).not.toBeInTheDocument();
  });

  it('lets the peer request control once the sharer can accept it', async () => {
    const user = userEvent.setup();
    const fake = fakeSession();
    fake.control.canRequest.set(true);
    fake.control.peerAvailableScopes.set(['pointer', 'keyboard']);
    const control = await renderPanel(fake);

    expect(screen.getByText('Available: pointer · keyboard')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Request control' }));

    expect(control.requestControl).toHaveBeenCalledOnce();
  });

  it('disables the request button while a request is pending', async () => {
    const fake = fakeSession();
    fake.control.canRequest.set(true);
    fake.control.state.set('requesting');
    await renderPanel(fake);

    expect(screen.getByRole('button', { name: 'Request sent' })).toBeDisabled();
  });

  it('asks the sharer for an explicit decision on an incoming request', async () => {
    const user = userEvent.setup();
    const fake = fakeSession();
    fake.control.incomingRequest.set({ scopes: ['pointer'] });
    const control = await renderPanel(fake);

    const dialog = screen.getByRole('alertdialog', { name: 'Control permission request' });
    expect(dialog).toHaveTextContent('Requested: pointer');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Allow' }));

    expect(control.reject).toHaveBeenCalledOnce();
    expect(control.allow).toHaveBeenCalledOnce();
  });

  it.each([
    ['controller', 'Control granted', 'Release control'],
    ['controlled', 'Peer has control permission', 'Stop control'],
  ] as const)('shows an active %s session with an exit', async (role, status, action) => {
    const user = userEvent.setup();
    const fake = fakeSession();
    fake.control.session.set({ role, scopes: ['pointer'] });
    const control = await renderPanel(fake);

    expect(screen.getByRole('status')).toHaveTextContent(status);
    expect(screen.getByText(/Expires in\s+42 seconds/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: action }));

    expect(control.release).toHaveBeenCalledOnce();
  });
});
