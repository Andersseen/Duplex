import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Automated accessibility smoke test. axe cannot certify the WebRTC collaboration surface as
 * accessible; it catches the regressions it can see (names, roles, contrast, landmarks) on the
 * three states every visitor passes through. Serious and critical violations fail the build.
 */
async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    // Entrance animations blend text with the background mid-flight, which axe reads as low
    // contrast. Reduced motion jumps straight to the final state, which is what users rest on.
    test.use({ colorScheme: scheme, reducedMotion: 'reduce' });

    test('landing page has no serious violations', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Start a call' })).toBeVisible();
      await expectNoSeriousViolations(page);
    });

    test('ready-to-join room has no serious violations', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Start a call' }).click();
      await expect(page.getByRole('heading', { name: 'Ready to join' })).toBeVisible();
      await expectNoSeriousViolations(page);
    });

    test('connected call shell has no serious violations', async ({ browser }) => {
      const first = await browser.newContext({
        colorScheme: scheme,
        reducedMotion: 'reduce',
        permissions: ['microphone'],
      });
      const second = await browser.newContext({
        colorScheme: scheme,
        reducedMotion: 'reduce',
        permissions: ['microphone'],
      });
      try {
        const host = await first.newPage();
        const guest = await second.newPage();
        await host.goto('/');
        await host.getByRole('button', { name: 'Start a call' }).click();
        await host.getByRole('button', { name: 'Join call' }).click();
        await guest.goto(host.url());
        await guest.getByRole('button', { name: 'Join call' }).click();
        await expect(host.getByRole('heading', { name: 'Connected' })).toBeVisible({
          timeout: 15_000,
        });
        await expectNoSeriousViolations(host);
      } finally {
        await first.close();
        await second.close();
      }
    });
  });
}
