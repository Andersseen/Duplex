import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<() => Promise<void>>(),
  onStatus: undefined as ((event: { payload: unknown }) => void) | undefined,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, listener: (event: { payload: unknown }) => void) => {
    await Promise.resolve();
    tauri.onStatus = listener;
    return vi.fn();
  }),
}));

import { App } from './app';

describe('App', () => {
  it('starts disconnected and explains that native input is not implemented', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Not connected');
    expect(element.querySelector('textarea[aria-label="Paste pairing code"]')).not.toBeNull();
    expect(element.textContent).not.toContain('Not connected to a call');
  });

  it('sends a pairing bundle to Rust, then clears the input', async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLTextAreaElement>('textarea');
    if (!input) throw new Error('Pairing input not found.');
    const token = 'test-secret-token';
    const pairingCode = `duplex-pair-v1.${token}`;
    input.value = pairingCode;
    input.dispatchEvent(new Event('input'));
    element.querySelector('button')?.dispatchEvent(new Event('click'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(tauri.invoke).toHaveBeenCalledWith('connect_helper', {
      pairingCode,
    });
    expect(element.querySelector('textarea')).toBeNull();
    expect(element.textContent).toContain('Connecting to Duplex');
    expect(element.textContent).not.toContain(token);
  });

  it('shows helper authorization and returns to waiting when revoked', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const status = tauri.onStatus;
    if (!status) throw new Error('Tauri event listener was not installed.');
    status({
      payload: {
        status: 'authorized',
        details: {
          controlSessionId: crypto.randomUUID(),
          surfaceId: crypto.randomUUID(),
          scopes: ['pointer', 'keyboard'],
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Control session authorized',
    );
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('pointer · keyboard');
    status({ payload: { status: 'connected', details: null } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Waiting for control permission',
    );
  });
});
