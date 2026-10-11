import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ROOM = '/r/AAAAAAAAAAAAAAAAAAAAAA';

const REQUIRED_HEADERS: Record<string, RegExp> = {
  'content-security-policy': /default-src 'self'.*object-src 'none'.*frame-ancestors 'none'/,
  'x-content-type-options': /^nosniff$/,
  'x-frame-options': /^DENY$/,
  'referrer-policy': /^no-referrer$/,
  'permissions-policy':
    /camera=\(self\).*microphone=\(self\).*display-capture=\(self\).*clipboard-read=\(self\).*clipboard-write=\(self\)/,
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

const sha256 = (body: string): string =>
  `'sha256-${createHash('sha256').update(body).digest('base64')}'`;

/** The executable inline scripts in a document, i.e. the ones a strict CSP has to authorize. */
function executableInlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !/type="application\/json"/.test(match[1] ?? ''))
    .map((match) => match[2] ?? '');
}

const scriptSrc = (csp: string): string =>
  csp
    .split(';')
    .find((directive) => directive.trim().startsWith('script-src'))
    ?.trim() ?? '';

test.describe('production strict script CSP', () => {
  for (const path of ['/', ROOM]) {
    test(`${path} authorizes exactly its own inline scripts by hash`, async ({ request }) => {
      const response = await request.get(path);
      const csp = response.headers()['content-security-policy'] ?? '';
      const directive = scriptSrc(csp);
      expect(directive).toMatch(/^script-src 'self'( 'sha256-[A-Za-z0-9+/]+={0,2}')+$/);
      expect(csp).not.toContain('unsafe-eval');
      expect(directive).not.toContain('unsafe-inline');
      const scripts = executableInlineScripts(await response.text());
      expect(scripts.length).toBeGreaterThanOrEqual(2);
      for (const script of scripts)
        expect(directive, script.slice(0, 40)).toContain(sha256(script));
      // The rest of the policy keeps its strength.
      for (const part of [
        "default-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ])
        expect(csp).toContain(part);
    });
  }

  test('inline bootstrap runs, but an injected inline script is blocked', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __violations: string[] }).__violations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        (window as unknown as { __violations: string[] }).__violations.push(
          event.violatedDirective,
        );
      });
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start a call' })).toBeVisible();
    const result = await page.evaluate(() => {
      const probe = window as unknown as {
        __jsaction_bootstrap?: unknown;
        __injected?: boolean;
        __violations: string[];
      };
      const script = document.createElement('script');
      script.textContent = 'window.__injected = true;';
      document.body.append(script);
      return {
        bootstrap: typeof probe.__jsaction_bootstrap,
        injected: probe.__injected ?? false,
        violations: probe.__violations,
      };
    });
    expect(result.bootstrap).toBe('function');
    expect(result.injected).toBe(false);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
      )
      .toContain('script-src-elem');
  });

  test('event replay and hydration still work: a click made before the app boots is replayed', async ({
    page,
  }) => {
    const problems = watchForViolations(page);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold back the application entry so the click happens while only the inline contract is live.
    await page.route('**/assets/index-*.js', async (route) => {
      await gate;
      await route.continue();
    });
    // Module scripts delay DOMContentLoaded, so resolve on the first response bytes instead.
    await page.goto('/', { waitUntil: 'commit' });
    await page.getByRole('button', { name: 'Start a call' }).click();
    await expect(page.getByRole('heading', { name: 'Ready to join' })).toBeHidden();
    release();
    await expect(page.getByRole('heading', { name: 'Ready to join' })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('lazy chunks load under the policy when navigating client-side', async ({ page }) => {
    const problems = watchForViolations(page);
    const chunks: string[] = [];
    page.on('response', (response) => {
      const url = response.url();
      if (/\/assets\/.+\.js$/.test(url) && response.status() === 200) chunks.push(url);
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start a call' })).toBeVisible();
    const before = chunks.length;
    await page.getByRole('button', { name: 'Start a call' }).click();
    await expect(page.getByRole('heading', { name: 'Ready to join' })).toBeVisible();
    expect(chunks.length).toBeGreaterThan(before);
    expect(problems).toEqual([]);
  });

  test('static assets and permissions keep their headers and policy', async ({ page, request }) => {
    const html = await (await request.get('/')).text();
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? '';
    const headers = (await request.get(asset)).headers();
    for (const [name, pattern] of Object.entries(REQUIRED_HEADERS))
      expect(headers[name], name).toMatch(pattern);
    await page.goto('/');
    const allowed = await page.evaluate(() => {
      const policy = (
        document as unknown as { featurePolicy: { allowsFeature(name: string): boolean } }
      ).featurePolicy;
      return Object.fromEntries(
        [
          'camera',
          'microphone',
          'display-capture',
          'clipboard-read',
          'clipboard-write',
          'geolocation',
        ].map((feature) => [feature, policy.allowsFeature(feature)]),
      );
    });
    expect(allowed).toEqual({
      camera: true,
      microphone: true,
      'display-capture': true,
      'clipboard-read': true,
      'clipboard-write': true,
      geolocation: false,
    });
  });
});

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
