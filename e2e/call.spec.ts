import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

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
