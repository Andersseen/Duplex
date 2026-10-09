import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { decodeHelperPairingBundle } from '@duplex/protocol';

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

test('Assist pairs one helper, grants pointer control, and relays validated input only while the grant is live', async ({
  browser,
}) => {
  const firstContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const secondContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
  // Test-only: a synthetic track has no real displaySurface, so report an entire monitor the way a
  // browser would. Production code has no such bypass; unknown surfaces never qualify.
  const syntheticMonitor = async (): Promise<void> => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable.');
    context.fillStyle = '#f4f4f5';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // A static canvas emits no frames, so animate it for the remote video to decode.
    const animate = (): void => {
      context.fillStyle = '#2563eb';
      context.fillRect((Date.now() / 8) % canvas.width, 690, 24, 20);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const stream = canvas.captureStream(15);
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('No synthetic video track.');
        const original = track.getSettings.bind(track);
        track.getSettings = () => ({ ...original(), displaySurface: 'monitor' });
        return stream;
      },
    });
  };
  // Test-only: expose received DataChannels so a hostile controller can be simulated.
  const exposeChannels = async (): Promise<void> => {
    const channels: Record<string, RTCDataChannel> = {};
    (window as unknown as { __dxChannels: typeof channels }).__dxChannels = channels;
    const Native = window.RTCPeerConnection;
    const Patched = function (
      this: RTCPeerConnection,
      ...args: ConstructorParameters<typeof Native>
    ) {
      const connection = new Native(...args);
      connection.addEventListener('datachannel', (event) => {
        channels[event.channel.label] = event.channel;
      });
      return connection;
    } as unknown as typeof RTCPeerConnection;
    Patched.prototype = Native.prototype;
    window.RTCPeerConnection = Patched;
  };
  await firstContext.addInitScript(syntheticMonitor);
  await secondContext.addInitScript(syntheticMonitor);
  await secondContext.addInitScript(exposeChannels);
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  let helper: WebSocket | null = null;
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

    await first.getByRole('button', { name: 'Share screen' }).click();
    await expect(first.getByLabel('Duplex Helper')).toBeVisible();
    await first.getByRole('button', { name: 'Create pairing code' }).click();
    const codeField = first.getByLabel('Helper pairing code');
    await expect(codeField).toBeVisible();
    const pairing = decodeHelperPairingBundle(await codeField.inputValue());
    const endpoint = new URL(`/api/rooms/${pairing.roomId}/helper/ws`, pairing.apiOrigin);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    helper = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${pairing.token}` } });
    await new Promise<void>((resolve, reject) => {
      helper?.once('open', () => resolve());
      helper?.once('error', reject);
    });
    const helperInputs: Record<string, unknown>[] = [];
    helper.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message['type'] === 'helper-input')
        helperInputs.push(message['input'] as Record<string, unknown>);
    });
    helper.send(JSON.stringify({ type: 'helper-ready' }));
    await expect(first.getByText('Helper connected')).toBeVisible({ timeout: 10_000 });

    // Paired but no capability yet: the controller cannot request anything.
    await expect(second.getByRole('button', { name: 'Request control' })).toHaveCount(0);
    helper.send(JSON.stringify({ type: 'helper-capabilities', availableScopes: ['pointer'] }));
    await expect(first.getByText('Pointer control is ready')).toBeVisible({ timeout: 10_000 });
    await expect(second.getByRole('button', { name: 'Request control' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(second.getByText('Keyboard — not available yet')).toBeVisible();
    await expect(second.locator('body')).not.toContainText(pairing.token);

    const nextHelperMessage = (type: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${type}.`)),
          10_000,
        );
        const onMessage = (data: WebSocket.RawData): void => {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (message['type'] !== type) return;
          clearTimeout(timeout);
          helper?.off('message', onMessage);
          resolve(message);
        };
        helper?.on('message', onMessage);
      });

    await second.getByRole('button', { name: 'Request control' }).click();
    await expect(
      first.getByRole('alertdialog', { name: 'Control permission request' }),
    ).toContainText('pointer');
    await expect(
      first.getByRole('alertdialog', { name: 'Control permission request' }),
    ).not.toContainText('keyboard');
    const authorizedResult = nextHelperMessage('helper-session-authorized');
    await first.getByRole('button', { name: 'Allow' }).click();
    await expect(second.getByText('Control granted')).toBeVisible();
    await expect(first.getByText('Peer has control permission')).toBeVisible();
    const authorized = await authorizedResult;
    const session = authorized['session'] as {
      controlSessionId: string;
      surfaceId: string;
      scopes: string[];
    };
    expect(session.scopes).toEqual(['pointer']);

    // The controller drives the shared screen with real pointer events.
    const remoteScreen = second.getByLabel('Peer video or shared screen');
    await expect.poll(() => remoteScreen.evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
    const bounds = await remoteScreen.boundingBox();
    if (!bounds) throw new Error('Remote shared video is not laid out.');
    // Aim in normalized shared-screen space, accounting for the video's letterboxing.
    const videoSize = await remoteScreen.evaluate((video) => ({
      width: video.videoWidth,
      height: video.videoHeight,
    }));
    const scale = Math.min(bounds.width / videoSize.width, bounds.height / videoSize.height);
    const content = {
      left: bounds.x + (bounds.width - videoSize.width * scale) / 2,
      top: bounds.y + (bounds.height - videoSize.height * scale) / 2,
      width: videoSize.width * scale,
      height: videoSize.height * scale,
    };
    const at = (x: number, y: number): [number, number] => [
      content.left + content.width * x,
      content.top + content.height * y,
    ];
    await second.mouse.move(...at(0.3, 0.4));
    await second.mouse.down();
    await second.mouse.move(...at(0.6, 0.5), { steps: 6 });
    await second.mouse.up();
    await second.mouse.move(...at(0.5, 0.5));
    await second.mouse.wheel(0, 120);

    await expect
      .poll(() => helperInputs.map((input) => input['type']), { timeout: 10_000 })
      .toContain('input-scroll');
    for (const input of helperInputs) {
      expect(input['controlSessionId']).toBe(session.controlSessionId);
      expect(input['surfaceId']).toBe(session.surfaceId);
      expect(input['protocolVersion']).toBe(1);
    }
    const buttons = helperInputs.filter((input) => input['type'] === 'input-pointer-button');
    expect(buttons.map((input) => `${String(input['button'])}-${String(input['state'])}`)).toEqual([
      'left-down',
      'left-up',
    ]);
    const down = buttons[0];
    expect(down?.['x']).toBeCloseTo(0.3, 2);
    expect(down?.['y']).toBeCloseTo(0.4, 2);
    const scroll = helperInputs.find((input) => input['type'] === 'input-scroll');
    expect(Number(scroll?.['deltaY'])).toBeGreaterThan(0);
    expect(helperInputs.some((input) => input['type'] === 'input-pointer-move')).toBe(true);
    // Sequence strictly increases and the click is ordered down → up.
    const sequences = helperInputs.map((input) => Number(input['sequence']));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    const downIndex = helperInputs.indexOf(buttons[0] ?? {});
    const upIndex = helperInputs.indexOf(buttons[1] ?? {});
    expect(downIndex).toBeLessThan(upIndex);

    // A right click is relayed as right down/up, and the browser context menu is suppressed.
    const beforeRight = helperInputs.length;
    await second.mouse.click(...at(0.7, 0.7), { button: 'right' });
    await expect
      .poll(() =>
        helperInputs
          .slice(beforeRight)
          .filter((input) => input['type'] === 'input-pointer-button')
          .map((input) => `${String(input['button'])}-${String(input['state'])}`),
      )
      .toEqual(['right-down', 'right-up']);

    // A hostile controller injecting directly on the channel is dropped by the controlled browser.
    const inject = (message: Record<string, unknown>): Promise<void> =>
      second.evaluate((payload) => {
        const channels = (window as unknown as { __dxChannels: Record<string, RTCDataChannel> })
          .__dxChannels;
        channels['duplex-input']?.send(JSON.stringify(payload));
      }, message);
    const base = {
      type: 'input-pointer-move',
      protocolVersion: 1,
      controlSessionId: session.controlSessionId,
      surfaceId: session.surfaceId,
      x: 0.5,
      y: 0.5,
    };
    const delivered = (): number => helperInputs.length;
    const before = delivered();
    await inject({ ...base, controlSessionId: crypto.randomUUID(), sequence: 900_001 });
    await inject({ ...base, surfaceId: crypto.randomUUID(), sequence: 900_002 });
    await inject({ ...base, type: 'input-key', key: 'a', sequence: 900_003 });
    await inject({ ...base, x: 4, sequence: 900_004 });
    await second.waitForTimeout(400);
    expect(delivered()).toBe(before);
    // Positive control: the same injection path delivers a correct message, so the drops above are real.
    await inject({ ...base, sequence: 900_005 });
    await expect.poll(delivered).toBe(before + 1);

    // The controlled user stops control; input stops flowing immediately.
    const revoked = nextHelperMessage('helper-session-revoked');
    await first.getByRole('button', { name: 'Stop control' }).click();
    await expect(second.getByText('Control granted')).toHaveCount(0);
    expect((await revoked)['type']).toBe('helper-session-revoked');
    const afterRevoke = delivered();
    await second.mouse.move(...at(0.2, 0.2));
    await second.mouse.down();
    await second.mouse.up();
    await second.mouse.wheel(0, 50);
    await inject({ ...base, sequence: 900_006 });
    await second.waitForTimeout(400);
    expect(delivered()).toBe(afterRevoke);

    // A fresh screen share is a new surface: nothing from the old session or surface is accepted.
    await first.getByRole('button', { name: 'Stop sharing' }).click();
    await first.getByRole('button', { name: 'Share screen' }).click();
    await expect(first.getByText('Pointer control is ready')).toBeVisible({ timeout: 10_000 });
    await expect(second.getByRole('button', { name: 'Request control' })).toBeVisible({
      timeout: 10_000,
    });
    await inject({ ...base, sequence: 900_007 });
    await second.waitForTimeout(400);
    expect(delivered()).toBe(afterRevoke);

    // Losing the helper capability removes the ability to request control.
    helper.send(JSON.stringify({ type: 'helper-capabilities', availableScopes: [] }));
    await expect(second.getByRole('button', { name: 'Request control' })).toHaveCount(0, {
      timeout: 10_000,
    });

    const replay = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${pairing.token}` },
    });
    const replayStatus = await new Promise<number>((resolve, reject) => {
      replay.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      replay.once('error', (error) => {
        if (!replay.listenerCount('unexpected-response')) reject(error);
      });
    });
    expect(replayStatus).toBe(401);
  } finally {
    helper?.close();
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
