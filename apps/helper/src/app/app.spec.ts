import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render as renderComponent, screen, waitFor } from '@testing-library/angular';
import { userEvent } from '@testing-library/user-event';

interface NativeStatus {
  platform: 'macos' | 'unsupported';
  accessibility: 'unsupported' | 'not-granted' | 'granted';
  displays: { id: number; name: string; width: number; height: number; selected: boolean }[];
  selectedDisplayId: number | null;
  pointerReady: boolean;
  keyboardAvailable: boolean;
  sessionActive: boolean;
}

const display = (id: number, selected = false) => ({
  id,
  name: `Display ${String(id)}`,
  width: id === 1 ? 2560 : 1920,
  height: id === 1 ? 1440 : 1080,
  selected,
});
const nativeStatus = (overrides: Partial<NativeStatus> = {}): NativeStatus => ({
  platform: 'macos',
  accessibility: 'granted',
  displays: [display(1, true)],
  selectedDisplayId: 1,
  pointerReady: true,
  keyboardAvailable: false,
  sessionActive: false,
  ...overrides,
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    await Promise.resolve();
    tauri.listeners.set(name, listener);
    return vi.fn();
  }),
}));

import { App } from './app';

const emit = (name: string, payload: unknown): void => {
  const listener = tauri.listeners.get(name);
  if (!listener) throw new Error(`No listener for ${name}.`);
  listener({ payload });
};

async function render(initial: NativeStatus = nativeStatus()) {
  tauri.invoke.mockImplementation((command) =>
    Promise.resolve(command === 'refresh_accessibility_status' ? initial : undefined),
  );
  const view = await renderComponent(App);
  // The initial native status arrives asynchronously from Rust.
  await screen.findByRole('region', { name: 'Native remote control' }).catch(() => undefined);
  return view;
}

/** Pushes a Rust-side event and lets Angular render it. */
async function push(name: string, payload: unknown): Promise<void> {
  emit(name, payload);
  await Promise.resolve();
}

const authorizedDetails = () => ({
  controlSessionId: crypto.randomUUID(),
  surfaceId: crypto.randomUUID(),
  scopes: ['pointer'],
  expiresAt: Date.now() + 60_000,
});

const PAIRING_LABEL = 'Paste pairing code';

describe('App', () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.listeners.clear();
  });

  it('starts disconnected with a pairing input', async () => {
    await render();

    expect(screen.getByRole('status')).toHaveTextContent('Not connected');
    expect(screen.getByRole('textbox', { name: PAIRING_LABEL })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('sends a pairing bundle to Rust, then clears the input and never displays it', async () => {
    const user = userEvent.setup();
    await render();
    const token = 'test-secret-token';
    const pairingCode = `duplex-pair-v1.${token}`;

    await user.type(screen.getByRole('textbox', { name: PAIRING_LABEL }), pairingCode);
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(tauri.invoke).toHaveBeenCalledWith('connect_helper', { pairingCode });
    expect(screen.queryByRole('textbox', { name: PAIRING_LABEL })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to Duplex');
    await push('helper-state', { status: 'connected', details: null });
    expect(await screen.findByText(/Waiting for control permission/)).toBeVisible();
    expect(document.body).not.toHaveTextContent(token);
  });

  it('shows a connection failure and lets the user retry', async () => {
    const user = userEvent.setup();
    await render();
    tauri.invoke.mockRejectedValueOnce(new Error('bad code'));

    await user.type(screen.getByRole('textbox', { name: PAIRING_LABEL }), 'duplex-pair-v1.x');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Check the pairing code');
    expect(screen.getByRole('textbox', { name: PAIRING_LABEL })).toHaveValue('');
    // Editing the field clears the stale error.
    await user.type(screen.getByRole('textbox', { name: PAIRING_LABEL }), 'again');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an error message pushed from Rust', async () => {
    await render();

    await push('helper-state', { status: 'error', details: { message: 'Room closed.' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Room closed.');
  });

  it('disconnects even when Rust reports an error', async () => {
    const user = userEvent.setup();
    await render();
    await push('helper-state', { status: 'connected', details: null });
    tauri.invoke.mockImplementation((command) =>
      command === 'disconnect_helper'
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(undefined),
    );

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

    expect(tauri.invoke).toHaveBeenCalledWith('disconnect_helper');
    expect(screen.getByRole('status')).toHaveTextContent('Not connected');
    expect(screen.getByRole('textbox', { name: PAIRING_LABEL })).toBeVisible();
  });

  it('shows paired-but-no-Accessibility and only prompts after the explicit button', async () => {
    const user = userEvent.setup();
    await render(nativeStatus({ accessibility: 'not-granted', pointerReady: false }));

    expect(screen.getByRole('button', { name: 'Enable Accessibility' })).toBeVisible();
    expect(screen.getByText('Enable Accessibility first')).toBeVisible();
    // Rendering and focusing never request access.
    expect(tauri.invoke).not.toHaveBeenCalledWith('request_accessibility', undefined);
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(command === 'request_accessibility' ? nativeStatus() : undefined),
    );

    await user.click(screen.getByRole('button', { name: 'Enable Accessibility' }));

    expect(tauri.invoke).toHaveBeenCalledWith('request_accessibility', undefined);
    expect(await screen.findByText('Granted')).toBeVisible();
    expect(screen.getByText('Ready')).toBeVisible();
  });

  it('re-checks Accessibility without prompting', async () => {
    const user = userEvent.setup();
    await render(nativeStatus({ accessibility: 'not-granted', pointerReady: false }));
    tauri.invoke.mockClear();

    await user.click(screen.getByRole('button', { name: 'Re-check' }));

    expect(tauri.invoke).toHaveBeenCalledWith('refresh_accessibility_status', undefined);
    expect(tauri.invoke).not.toHaveBeenCalledWith('request_accessibility', undefined);
  });

  it('re-checks when the window regains focus', async () => {
    await render();
    tauri.invoke.mockClear();

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith('refresh_accessibility_status', undefined);
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith('request_accessibility', undefined);
  });

  it('shows a lone display as the selected target and pointer as ready', async () => {
    await render();

    expect(screen.getByRole('radio', { name: /Display 1 — 2560 × 1440/ })).toBeChecked();
    expect(screen.getByText('Ready')).toBeVisible();
  });

  it('requires an explicit choice among several displays before pointer is ready', async () => {
    const user = userEvent.setup();
    await render(
      nativeStatus({
        displays: [display(1), display(2)],
        selectedDisplayId: null,
        pointerReady: false,
      }),
    );
    expect(screen.getByText('Choose the display your peer may control.')).toBeVisible();
    expect(screen.getByText('Choose a display')).toBeVisible();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === 'select_display'
          ? nativeStatus({
              displays: [display(1), display(2, true)],
              selectedDisplayId: 2,
              pointerReady: true,
            })
          : undefined,
      ),
    );

    await user.click(screen.getByRole('radio', { name: /Display 2/ }));

    expect(tauri.invoke).toHaveBeenCalledWith('select_display', { displayId: 2 });
    expect(await screen.findByText('Ready')).toBeVisible();
    expect(screen.getByRole('radio', { name: /Display 2/ })).toBeChecked();
  });

  it('reports no active display', async () => {
    await render(nativeStatus({ displays: [], selectedDisplayId: null, pointerReady: false }));

    expect(screen.getByText('No active display found.')).toBeVisible();
  });

  it('explains that native control is macOS-only elsewhere while pairing still works', async () => {
    await render(
      nativeStatus({
        platform: 'unsupported',
        accessibility: 'unsupported',
        displays: [],
        selectedDisplayId: null,
        pointerReady: false,
      }),
    );

    expect(screen.getByText(/available on macOS only/)).toBeVisible();
    expect(screen.getByText(/Pairing still works/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Enable Accessibility' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: PAIRING_LABEL })).toBeVisible();
  });

  it('shows keyboard only when the native helper reports it available and granted', async () => {
    await render(nativeStatus({ keyboardAvailable: true, sessionActive: true }));
    expect(screen.getByText('Keyboard control')).toBeVisible();
    expect(screen.getByText('Ready')).toBeVisible();

    await push('helper-state', {
      status: 'authorized',
      details: { ...authorizedDetails(), scopes: ['pointer', 'keyboard'] },
    });

    const session = await screen.findByRole('region', { name: 'Authorized control session' });
    expect(session).toHaveTextContent('pointer · keyboard');
    expect(screen.getAllByText('In use')).toHaveLength(2);
  });

  it('shows a keyboard-only grant when that is the authorized scope', async () => {
    await render();

    await push('helper-state', {
      status: 'authorized',
      details: { ...authorizedDetails(), scopes: ['keyboard'] },
    });

    expect(await screen.findByText('keyboard')).toBeVisible();
  });

  it('shows an authorized pointer session with Stop control, then returns to waiting when revoked', async () => {
    await render(nativeStatus({ sessionActive: true }));

    await push('helper-state', { status: 'authorized', details: authorizedDetails() });

    expect(await screen.findByText('Peer may control this Mac', { selector: 'h2' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop control' })).toBeVisible();
    expect(screen.getByText('In use')).toBeVisible();

    await push('helper-state', { status: 'connected', details: null });
    await push('native-state', nativeStatus());

    expect(await screen.findByText(/Waiting for control permission/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Stop control' })).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeVisible();
  });

  it('counts the session expiry down and stops at zero', async () => {
    vi.useFakeTimers();
    try {
      await render();
      const details = { ...authorizedDetails(), expiresAt: Date.now() + 61_000 };
      emit('helper-state', { status: 'authorized', details });
      await vi.advanceTimersByTimeAsync(0);
      expect(await screen.findByText('Expires in 1:01')).toBeVisible();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(await screen.findByText('Expires in 0:59')).toBeVisible();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(await screen.findByText('Expires in 0:00')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops control locally without disconnecting the helper', async () => {
    const user = userEvent.setup();
    await render();
    await push('helper-state', { status: 'authorized', details: authorizedDetails() });
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(command === 'stop_control' ? nativeStatus() : undefined),
    );

    await user.click(await screen.findByRole('button', { name: 'Stop control' }));

    expect(tauri.invoke).toHaveBeenCalledWith('stop_control', undefined);
    expect(tauri.invoke).not.toHaveBeenCalledWith('disconnect_helper', undefined);
    expect(
      screen.queryByText('Peer may control this Mac', { selector: 'h2' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Connected to Duplex call');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });

  it('keeps the previous native state when a command fails', async () => {
    const user = userEvent.setup();
    await render(nativeStatus({ accessibility: 'not-granted', pointerReady: false }));
    tauri.invoke.mockRejectedValue(new Error('denied'));

    await user.click(screen.getByRole('button', { name: 'Re-check' }));

    expect(screen.getByText('Enable Accessibility first')).toBeVisible();
  });

  it('reflects capability loss pushed from Rust', async () => {
    await render();
    expect(screen.getByText('Ready')).toBeVisible();

    await push(
      'native-state',
      nativeStatus({ accessibility: 'not-granted', pointerReady: false, sessionActive: false }),
    );

    expect(await screen.findByText('Enable Accessibility first')).toBeVisible();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('releases its Rust event listeners on destroy', async () => {
    const { fixture } = await render();

    expect(() => {
      fixture.destroy();
    }).not.toThrow();
  });
});
