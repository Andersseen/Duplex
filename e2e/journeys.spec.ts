import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ROOM_PATH = /\/r\/[A-Za-z0-9_-]{22}$/;

async function joinCall(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Join call' }).click();
  await expect(page.getByRole('group', { name: 'Call controls' })).toBeVisible();
}

test('landing explains the product and starts a fresh room', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Call. Share. Help.' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Platform status' })).toBeAttached();
  await page.getByRole('button', { name: 'Start a call' }).click();

  await expect(page).toHaveURL(ROOM_PATH);
  await expect(page.getByRole('heading', { name: 'Ready to join' })).toBeVisible();
});

test('every start gets a different, unguessable room', async ({ page }) => {
  const urls = new Set<string>();
  for (let index = 0; index < 3; index += 1) {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start a call' }).click();
    await expect(page).toHaveURL(ROOM_PATH);
    urls.add(page.url());
  }
  expect(urls.size).toBe(3);
});

test('a malformed room link is rejected before any microphone prompt', async ({ page }) => {
  await page.goto('/r/not-a-room');

  await expect(page.getByRole('heading', { name: 'Invalid room link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join call' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Start a new call' }).click();
  await expect(page).toHaveURL('/');
});

test('the host sees the invite link while waiting and can copy it', async ({ browser }) => {
  const context = await browser.newContext({
    permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start a call' }).click();
    await joinCall(page);

    await expect(page.getByRole('heading', { name: 'Waiting for someone to join…' })).toBeVisible();
    await expect(page.getByLabel('Copy this link')).toHaveValue(page.url());
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  } finally {
    await context.close();
  }
});

test('the landing page and call controls work from the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab'); // Docs
  await page.keyboard.press('Tab'); // GitHub
  await page.keyboard.press('Tab'); // Start a call
  await expect(page.getByRole('button', { name: 'Start a call' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(ROOM_PATH);

  const join = page.getByRole('button', { name: 'Join call' });
  await join.focus();
  await page.keyboard.press('Enter');
  const mute = page.getByRole('button', { name: 'Mute' });
  await expect(mute).toBeVisible();
  await mute.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  // Focus must be visible on the control that has it.
  const outline = await page.getByRole('button', { name: 'Unmute' }).evaluate((element) => {
    element.focus();
    return getComputedStyle(element).outlineStyle;
  });
  expect(outline).not.toBe('none');
});

const viewports = [
  { name: 'mobile', width: 375, height: 740 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 720 },
] as const;

for (const viewport of viewports) {
  test(`landing and room fit a ${viewport.name} viewport without sideways scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

    await page.goto('/');
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.getByRole('button', { name: 'Start a call' })).toBeInViewport();

    await page.getByRole('button', { name: 'Start a call' }).click();
    await joinCall(page);
    expect(await overflow()).toBeLessThanOrEqual(0);
    for (const name of ['Mute', 'Turn camera on', 'Share screen', 'Leave'])
      await expect(page.getByRole('button', { name })).toBeInViewport();
  });
}
