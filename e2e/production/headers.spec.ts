import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ROOM = '/r/AAAAAAAAAAAAAAAAAAAAAA';

const REQUIRED_HEADERS: Record<string, RegExp> = {
  'content-security-policy': /default-src 'self'.*object-src 'none'.*frame-ancestors 'none'/,
  'x-content-type-options': /^nosniff$/,
  'x-frame-options': /^DENY$/,
  'referrer-policy': /^no-referrer$/,
  'permissions-policy': /camera=\(self\).*microphone=\(self\).*display-capture=\(self\)/,
  'strict-transport-security': /max-age=\d+/,
};

/** Records CSP violations and page errors; both must stay empty for the shipped policy to be valid. */
function watchForViolations(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `CSP violation: ${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${String(event.lineNumber)} ${event.sample}`,
      );
    });
  });
  return problems;
}

test.describe('production security headers', () => {
  for (const path of ['/', ROOM, '/favicon.svg']) {
    test(`${path} ships the full header set`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      const headers = response.headers();
      for (const [name, pattern] of Object.entries(REQUIRED_HEADERS))
        expect(headers[name], name).toMatch(pattern);
      expect(Object.values(headers)).not.toContain('undefined');
    });
  }

  test('the CSP only allows signaling to the configured API origin', async ({ request }) => {
    const csp = (await request.get('/')).headers()['content-security-policy'] ?? '';
    expect(csp).toContain('connect-src');
    expect(csp).toContain('ws://localhost:8787');
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
    expect(csp).not.toMatch(/script-src[^;]*\*/);
  });

  test('landing hydrates and starts a call under the shipped policy', async ({ page }) => {
    const problems = watchForViolations(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Start a call' }).click();
    await expect(page.getByRole('heading', { name: 'Ready to join' })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('a call connects with microphone, signaling, WebRTC and screen share under the policy', async ({
    browser,
  }) => {
    const options = { permissions: ['microphone', 'camera'] as string[] };
    const hostContext = await browser.newContext(options);
    const guestContext = await browser.newContext(options);
    const syntheticScreen = (): void => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      const draw = (): void => {
        if (context) {
          context.fillStyle = '#2563eb';
          context.fillRect(Date.now() % 600, 10, 20, 20);
        }
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: () => Promise.resolve(canvas.captureStream(15)),
      });
    };
    await hostContext.addInitScript(syntheticScreen);
    try {
      const host = await hostContext.newPage();
      const guest = await guestContext.newPage();
      const hostProblems = watchForViolations(host);
      const guestProblems = watchForViolations(guest);
      await host.goto('/');
      await host.getByRole('button', { name: 'Start a call' }).click();
      await host.getByRole('button', { name: 'Join call' }).click();
      await guest.goto(host.url());
      await guest.getByRole('button', { name: 'Join call' }).click();
      await expect(host.getByRole('heading', { name: 'Connected' })).toBeVisible({
        timeout: 30_000,
      });
      await expect(guest.getByRole('heading', { name: 'Connected' })).toBeVisible({
        timeout: 30_000,
      });
      await host.getByRole('button', { name: 'Share screen' }).click();
      await expect(guest.getByLabel('Peer video or shared screen')).toBeVisible({
        timeout: 15_000,
      });
      await expect(guest.getByLabel('Screen collaboration tools')).toBeVisible({ timeout: 15_000 });
      // The shared stream is a real MediaStream, which the media-src directive must allow.
      await expect
        .poll(() =>
          guest
            .getByLabel('Peer video or shared screen')
            .evaluate((video: HTMLVideoElement) => video.videoWidth),
        )
        .toBeGreaterThan(0);
      // The WebSocket "ws:" error from an unreachable origin or a CSP block would appear here.
      expect(hostProblems).toEqual([]);
      expect(guestProblems).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
