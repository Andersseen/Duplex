import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import WebSocket from 'ws';
import { decodeHelperPairingBundle } from '@duplex/protocol';

const OUT = path.join(__dirname, '..', '..', 'docs', 'assets') + path.sep;

/** A clearly synthetic "shared screen": no real desktop content ever reaches a screenshot. */
const syntheticMonitor = (): void => {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  context.fillStyle = '#e4e4e7';
  context.fillRect(0, 0, 1280, 720);
  context.fillStyle = '#ffffff';
  context.fillRect(120, 90, 1040, 540);
  context.fillStyle = '#18181b';
  context.font = 'bold 44px sans-serif';
  context.fillText('Quarterly report (demo content)', 170, 190);
  context.fillStyle = '#a1a1aa';
  for (let line = 0; line < 5; line += 1)
    context.fillRect(170, 240 + line * 36, 760 - line * 60, 14);
  context.fillStyle = '#2563eb';
  for (let bar = 0; bar < 6; bar += 1)
    context.fillRect(210 + bar * 120, 560 - bar * 40, 80, 20 + bar * 40);
  const keepAlive = (): void => {
    context.fillStyle = '#e4e4e7';
    context.fillRect(0, 0, 4, 4);
    requestAnimationFrame(keepAlive);
  };
  requestAnimationFrame(keepAlive);
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: () => {
      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('No synthetic video track.');
      const original = track.getSettings.bind(track);
      track.getSettings = () => ({ ...original(), displaySurface: 'monitor' });
      return Promise.resolve(stream);
    },
  });
};

async function connect(
  browser: import('@playwright/test').Browser,
): Promise<{ host: Page; guest: Page; close: () => Promise<void> }> {
  const options = { permissions: ['microphone', 'camera'] as string[] };
  const hostContext = await browser.newContext({
    ...options,
    viewport: { width: 1280, height: 800 },
  });
  const guestContext = await browser.newContext({
    ...options,
    viewport: { width: 1280, height: 800 },
  });
  await hostContext.addInitScript(syntheticMonitor);
  await guestContext.addInitScript(syntheticMonitor);
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  await host.goto('/');
  await host.getByRole('button', { name: 'Start a call' }).click();
  await host.getByRole('button', { name: 'Join call' }).click();
  await guest.goto(host.url());
  await guest.getByRole('button', { name: 'Join call' }).click();
  await expect(host.getByRole('heading', { name: 'Connected' })).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByRole('heading', { name: 'Connected' })).toBeVisible({ timeout: 30_000 });
  return {
    host,
    guest,
    close: async () => {
      await hostContext.close();
      await guestContext.close();
    },
  };
}

test('landing page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Call. Share. Help.' })).toBeVisible();
  await page.screenshot({ path: `${OUT}landing.png`, fullPage: false });
});

test('screen sharing with collaboration tools', async ({ browser }) => {
  const { host, guest, close } = await connect(browser);
  try {
    await host.getByRole('button', { name: 'Share screen' }).click();
    await expect(guest.getByLabel('Screen collaboration tools')).toBeVisible({ timeout: 15_000 });
    await guest.getByRole('button', { name: 'Laser' }).click();
    await expect(guest.getByLabel('Peer video or shared screen')).toBeVisible();
    await guest.waitForTimeout(3_000);
    await guest.screenshot({ path: `${OUT}screen-sharing.png` });
  } finally {
    await close();
  }
});

test('Assist permission request', async ({ browser }) => {
  const { host, guest, close } = await connect(browser);
  let helper: WebSocket | null = null;
  try {
    await host.getByRole('button', { name: 'Share screen' }).click();
    await host.getByRole('button', { name: 'Create pairing code' }).click();
    const pairing = decodeHelperPairingBundle(
      await host.getByLabel('Helper pairing code').inputValue(),
    );
    const endpoint = new URL(`/api/rooms/${pairing.roomId}/helper/ws`, pairing.apiOrigin);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    helper = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${pairing.token}` } });
    await new Promise<void>((resolve, reject) => {
      helper?.once('open', () => resolve());
      helper?.once('error', reject);
    });
    helper.send(JSON.stringify({ type: 'helper-ready' }));
    helper.send(JSON.stringify({ type: 'helper-capabilities', availableScopes: ['pointer'] }));
    // The pairing code is gone once the helper connects, so nothing secret reaches the image.
    await expect(host.getByLabel('Helper pairing code')).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Request control' })).toBeVisible({
      timeout: 15_000,
    });
    await guest.getByRole('button', { name: 'Request control' }).click();
    await expect(
      host.getByRole('alertdialog', { name: 'Control permission request' }),
    ).toBeVisible();
    await host.waitForTimeout(3_000);
    await host.screenshot({ path: `${OUT}assist.png` });
  } finally {
    helper?.close();
    await close();
  }
});

test('native helper window', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 640 });
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number>();
    let nextId = 1;
    const status = {
      platform: 'macos',
      accessibility: 'granted',
      displays: [
        { id: 1, name: 'Built-in Retina Display', width: 3024, height: 1964, selected: true },
      ],
      selectedDisplayId: 1,
      pointerReady: true,
      keyboardAvailable: false,
      sessionActive: false,
    };
    const internals = {
      transformCallback: (callback: (event: unknown) => void) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: (command: string, args: { event?: string; handler?: number }) => {
        if (command === 'plugin:event|listen' && args.event && args.handler)
          listeners.set(args.event, args.handler);
        if (command === 'refresh_accessibility_status') return Promise.resolve(status);
        return Promise.resolve(command === 'plugin:event|listen' ? nextId++ : undefined);
      },
    };
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals });
    Object.defineProperty(window, '__emit', {
      value: (event: string, payload: unknown) => {
        const handler = listeners.get(event);
        if (handler) callbacks.get(handler)?.({ event, id: 0, payload });
      },
    });
  });
  await page.goto('http://127.0.0.1:4200');
  await expect(page.getByRole('region', { name: 'Native pointer control' })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit(
      'helper-state',
      { status: 'connected', details: null },
    );
  });
  await expect(page.getByText(/Waiting for control permission/)).toBeVisible();
  await page.screenshot({ path: `${OUT}helper.png` });
});
