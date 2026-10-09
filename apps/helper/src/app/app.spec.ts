import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  const fixture = TestBed.createComponent(App);
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const text = (): string => element.textContent;
  const button = (label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll('button')].find((candidate) =>
      candidate.textContent.includes(label),
    );
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, element, text, button, settle };
}

const authorizedDetails = () => ({
  controlSessionId: crypto.randomUUID(),
  surfaceId: crypto.randomUUID(),
  scopes: ['pointer'],
  expiresAt: Date.now() + 60_000,
});

describe('App', () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.listeners.clear();
  });

  it('starts disconnected with a pairing input', async () => {
    const { element, text } = await render();
    expect(text()).toContain('Not connected');
    expect(element.querySelector('textarea[aria-label="Paste pairing code"]')).not.toBeNull();
  });

  it('sends a pairing bundle to Rust, then clears the input and never displays it', async () => {
    const { element, text, settle } = await render();
    const input = element.querySelector<HTMLTextAreaElement>('textarea');
    if (!input) throw new Error('Pairing input not found.');
    const token = 'test-secret-token';
    const pairingCode = `duplex-pair-v1.${token}`;
    input.value = pairingCode;
    input.dispatchEvent(new Event('input'));
    await settle();
    element.querySelector('button')?.dispatchEvent(new Event('click'));
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith('connect_helper', { pairingCode });
    expect(element.querySelector('textarea')).toBeNull();
    expect(text()).toContain('Connecting to Duplex');
    expect(text()).not.toContain(token);
    emit('helper-state', { status: 'connected', details: null });
    await settle();
    expect(text()).not.toContain(token);
  });

  it('shows paired-but-no-Accessibility and only prompts after the explicit button', async () => {
    const { text, button, settle } = await render(
      nativeStatus({ accessibility: 'not-granted', pointerReady: false }),
    );
    expect(text()).toContain('Enable Accessibility');
    expect(text()).toContain('Enable Accessibility first');
    // Rendering, focusing and re-checking never request access.
    expect(tauri.invoke).not.toHaveBeenCalledWith('request_accessibility', undefined);
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(command === 'request_accessibility' ? nativeStatus() : undefined),
    );
    button('Enable Accessibility')?.click();
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith('request_accessibility', undefined);
    expect(text()).toContain('Granted');
    expect(text()).toContain('Ready');
  });

  it('re-checks Accessibility without prompting', async () => {
    const { button, settle } = await render(
      nativeStatus({ accessibility: 'not-granted', pointerReady: false }),
    );
    tauri.invoke.mockClear();
    button('Re-check')?.click();
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith('refresh_accessibility_status', undefined);
    expect(tauri.invoke).not.toHaveBeenCalledWith('request_accessibility', undefined);
  });

  it('shows a lone display as the selected target and pointer as ready', async () => {
    const { element, text } = await render();
    expect(text()).toContain('Display 1 — 2560 × 1440');
    expect(element.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(text()).toContain('Ready');
  });

  it('requires an explicit choice among several displays before pointer is ready', async () => {
    const { element, text, settle } = await render(
      nativeStatus({
        displays: [display(1), display(2)],
        selectedDisplayId: null,
        pointerReady: false,
      }),
    );
    expect(text()).toContain('Choose the display your peer may control.');
    expect(text()).toContain('Choose a display');
    expect([...element.querySelectorAll<HTMLInputElement>('input[type="radio"]')]).toHaveLength(2);
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
    const second = element.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    second?.dispatchEvent(new Event('change'));
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith('select_display', { displayId: 2 });
    expect(text()).toContain('Ready');
    expect(element.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]?.checked).toBe(
      true,
    );
  });

  it('explains that native control is macOS-only elsewhere while pairing still works', async () => {
    const { element, text } = await render(
      nativeStatus({
        platform: 'unsupported',
        accessibility: 'unsupported',
        displays: [],
        selectedDisplayId: null,
        pointerReady: false,
      }),
    );
    expect(text()).toContain('available on macOS only');
    expect(text()).toContain('Pairing still works');
    expect(text()).not.toContain('Enable Accessibility');
    expect(element.querySelector('textarea[aria-label="Paste pairing code"]')).not.toBeNull();
  });

  it('never presents keyboard control as available', async () => {
    const { text, settle } = await render();
    expect(text()).toContain('Keyboard control');
    expect(text()).toContain('Not implemented yet');
    emit('helper-state', {
      status: 'authorized',
      details: { ...authorizedDetails(), scopes: ['pointer', 'keyboard'] },
    });
    await settle();
    expect(text()).toContain('Pointer');
    expect(text()).not.toContain('pointer · keyboard');
  });

  it('shows an authorized pointer session with Stop control, then returns to waiting when revoked', async () => {
    const { text, settle } = await render(nativeStatus({ sessionActive: true }));
    emit('helper-state', { status: 'authorized', details: authorizedDetails() });
    await settle();
    expect(text()).toContain('Peer may control this Mac');
    expect(text()).toContain('Stop control');
    expect(text()).toContain('In use');
    emit('helper-state', { status: 'connected', details: null });
    emit('native-state', nativeStatus());
    await settle();
    expect(text()).toContain('Waiting for control permission');
    expect(text()).not.toContain('Stop control');
    expect(text()).toContain('Ready');
  });

  it('stops control locally without disconnecting the helper', async () => {
    const { text, button, settle } = await render();
    emit('helper-state', { status: 'authorized', details: authorizedDetails() });
    await settle();
    tauri.invoke.mockImplementation((command) =>
      Promise.resolve(command === 'stop_control' ? nativeStatus() : undefined),
    );
    button('Stop control')?.click();
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith('stop_control', undefined);
    expect(tauri.invoke).not.toHaveBeenCalledWith('disconnect_helper', undefined);
    expect(text()).not.toContain('Peer may control this Mac');
    expect(text()).toContain('Connected to Duplex call');
    expect(button('Disconnect')).toBeDefined();
  });

  it('reflects capability loss pushed from Rust', async () => {
    const { text, settle } = await render();
    expect(text()).toContain('Ready');
    emit(
      'native-state',
      nativeStatus({ accessibility: 'not-granted', pointerReady: false, sessionActive: false }),
    );
    await settle();
    expect(text()).toContain('Enable Accessibility first');
    expect(text()).not.toContain('Ready');
  });
});
