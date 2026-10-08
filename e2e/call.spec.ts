import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function openHydratedPage(page: Page, url: string): Promise<void> {
  const hydrated = new Promise<void>((resolve) => {
    const onConsole = (message: ConsoleMessage): void => {
      if (!message.text().startsWith('Angular hydrated ')) return;
      page.off('console', onConsole);
      resolve();
    };
    page.on('console', onConsole);
  });
  await page.goto(url);
  await hydrated;
}

test('two browser contexts can call, change media, and release room capacity', async ({
  browser,
}) => {
  const firstContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const secondContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const thirdContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const third = await thirdContext.newPage();

  try {
    await openHydratedPage(first, '/');
    await first.getByRole('button', { name: 'Start a call' }).click();
    await expect(first).toHaveURL(/\/r\//);
    const roomUrl = first.url();
    await first.getByRole('button', { name: 'Join call' }).click();
    await expect(first.getByRole('button', { name: 'Mute' })).toBeVisible();

    await openHydratedPage(second, roomUrl);
    await second.getByRole('button', { name: 'Join call' }).click();
    await expect(first.getByRole('heading', { name: 'Connected' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(second.getByRole('heading', { name: 'Connected' })).toBeVisible({
      timeout: 30_000,
    });

    await first.getByRole('button', { name: 'Mute' }).click();
    await expect(first.getByRole('button', { name: 'Unmute' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await first.getByRole('button', { name: 'Unmute' }).click();
    await expect(first.getByRole('button', { name: 'Mute' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await first.getByRole('button', { name: 'Turn camera on' }).click();
    await expect(first.getByRole('button', { name: 'Camera off' })).toBeVisible();
    await first.getByRole('button', { name: 'Camera off' }).click();
    await expect(first.getByRole('button', { name: 'Turn camera on' })).toBeVisible();

    await openHydratedPage(third, roomUrl);
    await third.getByRole('button', { name: 'Join call' }).click();
    await expect(third.getByRole('alert')).toContainText('already has two participants', {
      timeout: 10_000,
    });

    await second.getByRole('button', { name: 'Leave' }).click();
    await expect(first.getByRole('heading', { name: 'Waiting for someone to join…' })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close(), thirdContext.close()]);
  }
});

test('peers collaborate over WebRTC while a synthetic screen is shared', async ({ browser }) => {
  const firstContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const secondContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const syntheticScreen = async (): Promise<void> => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable.');
    context.fillStyle = '#f4f4f5';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#18181b';
    context.font = '48px sans-serif';
    context.fillText('Duplex synthetic share', 80, 120);
    const animate = (): void => {
      context.fillStyle = '#f4f4f5';
      context.fillRect(0, 680, canvas.width, 40);
      context.fillStyle = '#2563eb';
      context.fillRect((Date.now() / 8) % canvas.width, 690, 24, 20);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => canvas.captureStream(15),
    });
  };
  await firstContext.addInitScript(syntheticScreen);
  await secondContext.addInitScript(syntheticScreen);
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    await openHydratedPage(first, '/');
    await first.getByRole('button', { name: 'Start a call' }).click();
    await expect(first).toHaveURL(/\/r\//);
    const roomUrl = first.url();
    await first.getByRole('button', { name: 'Join call' }).click();
    await openHydratedPage(second, roomUrl);
    await second.getByRole('button', { name: 'Join call' }).click();
    await expect(first.getByRole('heading', { name: 'Connected' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(second.getByRole('heading', { name: 'Connected' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(first.getByLabel('Screen collaboration tools')).toHaveCount(0);

    await first.getByRole('button', { name: 'Share screen' }).click();
    await expect(first.getByLabel('Screen collaboration tools')).toBeVisible();
    await expect(second.getByLabel('Screen collaboration tools')).toBeVisible({ timeout: 15_000 });

    const remoteScreen = second.getByLabel('Peer video or shared screen');
    await expect.poll(() => remoteScreen.evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
    const bounds = await remoteScreen.boundingBox();
    if (!bounds) throw new Error('Remote shared video is not laid out.');
    await second.getByRole('button', { name: 'Pointer' }).click();
    await expect(second.getByRole('button', { name: 'Pointer' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await second.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(
      first.locator('svg[aria-label="Shared screen collaboration surface"] circle'),
    ).toBeVisible({
      timeout: 5000,
    });

    await second.getByRole('button', { name: 'Draw' }).click();
    await second.mouse.move(bounds.x + bounds.width * 0.35, bounds.y + bounds.height * 0.4);
    await second.mouse.down();
    await second.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.6, {
      steps: 8,
    });
    await second.mouse.up();
    await expect(
      second.locator('svg[aria-label="Shared screen collaboration surface"] path'),
    ).toHaveCount(1);
    await expect(
      first.locator('svg[aria-label="Shared screen collaboration surface"] path'),
    ).toHaveCount(1, { timeout: 5000 });
    await first.getByRole('button', { name: 'Clear' }).click();
    await expect(
      first.locator('svg[aria-label="Shared screen collaboration surface"] path'),
    ).toHaveCount(0);
    await expect(
      second.locator('svg[aria-label="Shared screen collaboration surface"] path'),
    ).toHaveCount(0);

    await first.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(first.getByLabel('Screen collaboration tools')).toHaveCount(0);
    await expect(second.getByLabel('Screen collaboration tools')).toHaveCount(0, { timeout: 5000 });
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()]);
  }
});

test('forced relay call selects a relay candidate', async ({ browser }) => {
  test.skip(
    process.env.DUPLEX_E2E_TURN !== 'true',
    'Run with pnpm e2e:turn and local TURN secrets.',
  );
  const firstContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const secondContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    await openHydratedPage(first, '/');
    await first.getByRole('button', { name: 'Start a call' }).click();
    await expect(first).toHaveURL(/\/r\//);
    const roomUrl = first.url();
    await first.getByRole('button', { name: 'Join call' }).click();
    await openHydratedPage(second, roomUrl);
    await second.getByRole('button', { name: 'Join call' }).click();
    await expect(first.getByRole('heading', { name: 'Connected' })).toBeVisible({
      timeout: 45_000,
    });
    await expect(second.getByRole('heading', { name: 'Connected' })).toBeVisible({
      timeout: 45_000,
    });
    await expect(first.getByText('relay path')).toBeVisible({ timeout: 15_000 });
    await expect(second.getByText('relay path')).toBeVisible({ timeout: 15_000 });
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()]);
  }
});

test('peers transfer and download the exact file bytes over the DataChannel', async ({
  browser,
}) => {
  const firstContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const secondContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const contents = Buffer.from([0, 1, 2, 3, 13, 10, 127, 128, 254, 255]);
  try {
    await openHydratedPage(first, '/');
    await first.getByRole('button', { name: 'Start a call' }).click();
    await expect(first).toHaveURL(/\/r\//);
    const roomUrl = first.url();
    await first.getByRole('button', { name: 'Join call' }).click();
    await openHydratedPage(second, roomUrl);
    await second.getByRole('button', { name: 'Join call' }).click();
    await expect(first.getByRole('heading', { name: 'Connected' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(second.getByRole('heading', { name: 'Connected' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(first.getByRole('button', { name: 'Send file' })).toBeVisible({ timeout: 30_000 });
    await expect(second.getByRole('button', { name: 'Send file' })).toBeVisible({
      timeout: 30_000,
    });

    await first.getByLabel('Choose files to send').setInputFiles({
      name: 'transfer-fixture.bin',
      mimeType: 'application/octet-stream',
      buffer: contents,
    });
    await expect(second.getByText('Peer wants to send')).toBeVisible();
    await expect(second.getByText('transfer-fixture.bin')).toBeVisible();
    await second.getByRole('button', { name: 'Accept' }).click();
    const downloadPromise = second.waitForEvent('download');
    await expect(second.getByRole('link', { name: 'Download' })).toBeVisible({ timeout: 30_000 });
    await second.getByRole('link', { name: 'Download' }).click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    if (!downloadedPath) throw new Error('Playwright did not provide the downloaded file path.');
    expect(await readFile(downloadedPath)).toEqual(contents);

    await first.getByLabel('Choose files to send').setInputFiles({
      name: 'declined-fixture.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('decline me'),
    });
    await expect(second.getByText('declined-fixture.txt')).toBeVisible();
    await second.getByRole('button', { name: 'Decline' }).click();
    await expect(second.getByRole('link', { name: 'Download' })).toHaveCount(1);
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()]);
  }
});
