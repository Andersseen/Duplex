import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { userEvent } from '@testing-library/user-event';
import { CallSessionService } from '../services/call-session.service';
import { AssistPanel } from './assist-panel';

function fakeSession() {
  const clipboard = {
    available: signal(false),
    busy: signal(false),
    canReadLocal: signal(true),
    canWriteLocal: signal(true),
    notice: signal<{ tone: 'info' | 'error'; text: string } | null>(null),
    receivedCharacters: signal<number | null>(null),
    incomingRead: signal<{ transferId: string } | null>(null),
    peerWrote: signal<{ characters: number } | null>(null),
    sendLocalClipboard: vi.fn(),
    requestRemoteClipboard: vi.fn(),
    copyReceived: vi.fn(),
    discardReceived: vi.fn(),
    approveRead: vi.fn(),
    declineRead: vi.fn(),
  };
  const control = {
    session: signal<{ role: 'controller' | 'controlled'; scopes: string[] } | null>(null),
    incomingRequest: signal<{ requestId: string; scopes: string[] } | null>(null),
    peerAvailableScopes: signal<string[]>([]),
    canRequest: signal(false),
    state: signal<'idle' | 'requesting'>('idle'),
    remainingSeconds: signal(42),
    requestControl: vi.fn(),
    allow: vi.fn(),
    reject: vi.fn(),
    release: vi.fn(),
  };
  return { control, clipboard };
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

    expect(control.requestControl).toHaveBeenCalledWith(['pointer', 'keyboard']);
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
    fake.control.incomingRequest.set({ requestId: 'r1', scopes: ['pointer'] });
    const control = await renderPanel(fake);

    const dialog = screen.getByRole('alertdialog', { name: 'Control permission request' });
    expect(dialog).toHaveTextContent('Requested: pointer');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Allow' }));

    expect(control.reject).toHaveBeenCalledOnce();
    expect(control.allow).toHaveBeenCalledWith(['pointer']);
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

  describe('clipboard', () => {
    it('offers the clipboard as an explicit, unchecked opt-in when requesting control', async () => {
      const user = userEvent.setup();
      const fake = fakeSession();
      fake.control.canRequest.set(true);
      fake.control.peerAvailableScopes.set(['pointer', 'keyboard', 'clipboard']);
      const control = await renderPanel(fake);

      const box = screen.getByRole('checkbox', { name: /Clipboard text/ });
      expect(box).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: /Pointer/ })).toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Request control' }));
      expect(control.requestControl).toHaveBeenLastCalledWith(['pointer', 'keyboard']);

      await user.click(box);
      await user.click(screen.getByRole('button', { name: 'Request control' }));
      expect(control.requestControl).toHaveBeenLastCalledWith(['pointer', 'keyboard', 'clipboard']);
    });

    it('cannot request control with nothing selected', async () => {
      const user = userEvent.setup();
      const fake = fakeSession();
      fake.control.canRequest.set(true);
      fake.control.peerAvailableScopes.set(['clipboard']);
      await renderPanel(fake);

      expect(screen.getByRole('button', { name: 'Request control' })).toBeDisabled();
      await user.click(screen.getByRole('checkbox', { name: /Clipboard text/ }));
      expect(screen.getByRole('button', { name: 'Request control' })).toBeEnabled();
    });

    it('describes the clipboard scope and leaves it unchecked in the permission dialog', async () => {
      const user = userEvent.setup();
      const fake = fakeSession();
      fake.control.incomingRequest.set({ requestId: 'r2', scopes: ['pointer', 'clipboard'] });
      const control = await renderPanel(fake);

      const dialog = screen.getByRole('alertdialog', { name: 'Control permission request' });
      expect(dialog).toHaveTextContent('Plain text only, up to 4 KiB');
      expect(dialog).toHaveTextContent('You approve every read of your clipboard');
      expect(screen.getByRole('checkbox', { name: /Clipboard text/ })).not.toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Allow' }));
      expect(control.allow).toHaveBeenLastCalledWith(['pointer']);

      await user.click(screen.getByRole('checkbox', { name: /Clipboard text/ }));
      await user.click(screen.getByRole('button', { name: 'Allow' }));
      expect(control.allow).toHaveBeenLastCalledWith(['pointer', 'clipboard']);
    });

    it('disables Allow when every requested scope is unchecked', async () => {
      const user = userEvent.setup();
      const fake = fakeSession();
      fake.control.incomingRequest.set({ requestId: 'r3', scopes: ['clipboard'] });
      await renderPanel(fake);

      expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
      await user.click(screen.getByRole('checkbox', { name: /Clipboard text/ }));
      expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
    });

    it('shows clipboard actions only when the clipboard is available and authorized', async () => {
      const fake = fakeSession();
      fake.control.session.set({ role: 'controller', scopes: ['pointer'] });
      await renderPanel(fake);
      expect(
        screen.queryByRole('button', { name: 'Send my clipboard text' }),
      ).not.toBeInTheDocument();
    });

    it('lets the controller send, request and copy only through explicit clicks', async () => {
      const user = userEvent.setup();
      const fake = fakeSession();
      fake.control.session.set({ role: 'controller', scopes: ['clipboard'] });
      fake.clipboard.available.set(true);
      fake.clipboard.receivedCharacters.set(12);
      await renderPanel(fake);

      expect(fake.clipboard.sendLocalClipboard).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Send my clipboard text' }));
      await user.click(screen.getByRole('button', { name: 'Get remote clipboard text' }));
      expect(screen.getByText(/Remote text ready \(12 characters\)/)).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Copy to my clipboard' }));
      await user.click(screen.getByRole('button', { name: 'Discard' }));
      expect(fake.clipboard.sendLocalClipboard).toHaveBeenCalledOnce();
      expect(fake.clipboard.requestRemoteClipboard).toHaveBeenCalledOnce();
      expect(fake.clipboard.copyReceived).toHaveBeenCalledOnce();
      expect(fake.clipboard.discardReceived).toHaveBeenCalledOnce();
    });

    it('disables clipboard actions while busy and when the browser lacks the API', async () => {
      const fake = fakeSession();
      fake.control.session.set({ role: 'controller', scopes: ['clipboard'] });
      fake.clipboard.available.set(true);
      fake.clipboard.canReadLocal.set(false);
      await renderPanel(fake);
      expect(screen.getByRole('button', { name: 'Send my clipboard text' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Get remote clipboard text' })).toBeEnabled();
      expect(screen.getByText(/limits clipboard access/)).toBeVisible();
    });

    it('announces notices, with errors as alerts', async () => {
      const fake = fakeSession();
      fake.control.session.set({ role: 'controller', scopes: ['clipboard'] });
      fake.clipboard.available.set(true);
      fake.clipboard.notice.set({ tone: 'error', text: 'The browser did not allow reading.' });
      await renderPanel(fake);
      expect(screen.getByRole('alert')).toHaveTextContent('The browser did not allow reading.');
    });

    it('asks the controlled user to approve each read and states what was written', async () => {
      const user = userEvent.setup();
      const fake = fakeSession();
      fake.control.session.set({ role: 'controlled', scopes: ['clipboard'] });
      fake.clipboard.incomingRead.set({ transferId: 't1' });
      fake.clipboard.peerWrote.set({ characters: 5 });
      await renderPanel(fake);

      const dialog = screen.getByRole('alertdialog', { name: 'Clipboard read request' });
      expect(dialog).toHaveTextContent('copy the text on your clipboard');
      expect(screen.getByText(/put 5 characters of text on your clipboard/)).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Decline' }));
      await user.click(screen.getByRole('button', { name: 'Share once' }));
      expect(fake.clipboard.declineRead).toHaveBeenCalledOnce();
      expect(fake.clipboard.approveRead).toHaveBeenCalledOnce();
    });

    it('shows no clipboard prompts for a controlled pointer-only session', async () => {
      const fake = fakeSession();
      fake.control.session.set({ role: 'controlled', scopes: ['pointer'] });
      fake.clipboard.incomingRead.set({ transferId: 't2' });
      await renderPanel(fake);
      expect(
        screen.queryByRole('alertdialog', { name: 'Clipboard read request' }),
      ).not.toBeInTheDocument();
    });
  });
});
