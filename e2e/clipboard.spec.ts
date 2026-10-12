import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, ConsoleMessage, Locator, Page } from '@playwright/test';
import WebSocket from 'ws';
import { decodeHelperPairingBundle, MAX_CLIPBOARD_TEXT_BYTES } from '@duplex/protocol';

type Json = Record<string, unknown>;

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

// Test-only: a synthetic track has no real displaySurface, so report an entire monitor the way a
// browser would. Production code has no such bypass; unknown surfaces never qualify.
const syntheticMonitor = async (): Promise<void> => {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  const animate = (): void => {
    context.fillStyle = '#f4f4f5';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#2563eb';
    context.fillRect((Date.now() / 8) % canvas.width, 300, 24, 20);
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: () => {
      const track = canvas.captureStream(15).getVideoTracks()[0];
      if (!track) return Promise.reject(new Error('No synthetic video track.'));
      const original = track.getSettings.bind(track);
      track.getSettings = () => ({ ...original(), displaySurface: 'monitor' });
      return Promise.resolve(new MediaStream([track]));
    },
  });
};

// Test-only: expose the input DataChannel and record every clipboard frame this page sends, so a
// hostile controller (replay, other session, oversized text) can be simulated byte-for-byte.
const exposeInputChannel = async (): Promise<void> => {
  const channels: Record<string, RTCDataChannel> = {};
  const sent: string[] = [];
  Object.assign(window, { __dxChannels: channels, __dxSent: sent });
  const nativeSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: never): void {
    if (typeof data === 'string' && data.includes('"clipboard-')) sent.push(data);
    nativeSend.call(this, data);
  };
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

/** Stands in for the native macOS helper; it records what the room relays and answers like Rust. */
class FakeHelper {
  readonly socket: WebSocket;
  readonly messages: Json[] = [];
  clipboard = 'text that lives on the controlled Mac';
  writeOutcome: 'ok' | 'denied' | 'failed' = 'ok';
  written: string[] = [];
  reads = 0;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Json;
      this.messages.push(message);
      if (message['type'] === 'helper-clipboard-write') {
        const outcome = this.writeOutcome;
        if (outcome === 'ok') this.written.push(String(message['text']));
        this.answer(message, outcome);
      } else if (message['type'] === 'helper-clipboard-read') {
        this.reads += 1;
        this.answer(message, 'ok', this.clipboard);
      }
    });
  }

  static async connect(page: Page): Promise<FakeHelper> {
    await page.getByRole('button', { name: 'Create pairing code' }).click();
    const pairing = decodeHelperPairingBundle(
      await page.getByLabel('Helper pairing code').inputValue(),
    );
    const endpoint = new URL(`/api/rooms/${pairing.roomId}/helper/ws`, pairing.apiOrigin);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${pairing.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'helper-ready' }));
    await expect(page.getByText('Helper connected')).toBeVisible({ timeout: 10_000 });
    return new FakeHelper(socket);
  }

  capabilities(scopes: string[]): void {
    this.socket.send(JSON.stringify({ type: 'helper-capabilities', availableScopes: scopes }));
  }

  of(type: string): Json[] {
    return this.messages.filter((message) => message['type'] === type);
  }

  close(): void {
    this.socket.close();
  }

  private answer(request: Json, outcome: string, text?: string): void {
    this.socket.send(
      JSON.stringify({
        type: 'helper-clipboard-result',
        controlSessionId: request['controlSessionId'],
        transferId: request['transferId'],
        outcome,
        ...(text === undefined ? {} : { text }),
      }),
    );
  }
}

interface Room {
  readonly sharer: Page;
  readonly controller: Page;
  readonly controllerContext: BrowserContext;
  readonly helper: FakeHelper;
  close(): Promise<void>;
}

async function startRoom(
  browser: Browser,
  options: { scopes: string[]; controllerInit?: () => void; clipboardPermissions?: boolean },
): Promise<Room> {
  const permissions = ['microphone', 'camera'];
  const sharerContext = await browser.newContext({ permissions });
  const controllerContext = await browser.newContext({
    permissions:
      options.clipboardPermissions === false
        ? permissions
        : [...permissions, 'clipboard-read', 'clipboard-write'],
  });
  await sharerContext.addInitScript(syntheticMonitor);
  await controllerContext.addInitScript(exposeInputChannel);
  if (options.controllerInit) await controllerContext.addInitScript(options.controllerInit);
  const sharer = await sharerContext.newPage();
  const controller = await controllerContext.newPage();
  await openHydratedPage(sharer, '/');
  await sharer.getByRole('button', { name: 'Start a call' }).click();
  await expect(sharer).toHaveURL(/\/call\//);
  const roomUrl = sharer.url();
  await sharer.getByRole('button', { name: 'Join call' }).click();
  await openHydratedPage(controller, roomUrl);
  await controller.getByRole('button', { name: 'Join call' }).click();
  for (const page of [sharer, controller])
    await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible({ timeout: 30_000 });
  await sharer.getByRole('button', { name: 'Share screen' }).click();
  await expect(sharer.getByLabel('Duplex Helper')).toBeVisible();
  const helper = await FakeHelper.connect(sharer);
  helper.capabilities(options.scopes);
  await expect(controller.getByRole('button', { name: 'Request control' })).toBeVisible({
    timeout: 10_000,
  });
  return {
    sharer,
    controller,
    controllerContext,
    helper,
    close: async () => {
      helper.close();
      await Promise.allSettled([sharerContext.close(), controllerContext.close()]);
    },
  };
}

const dialog = (page: Page) =>
  page.getByRole('alertdialog', { name: 'Control permission request' });
const clipboardBox = (page: Page) => page.getByRole('checkbox', { name: /Clipboard text/ });

async function setCheckbox(locator: Locator, checked: boolean): Promise<void> {
  if ((await locator.getAttribute('aria-checked')) === String(checked)) return;
  await locator.click();
  await expect(locator).toHaveAttribute('aria-checked', String(checked));
}

/** Request only the clipboard scope and have the sharer allow it. */
async function grantClipboard(room: Room, extra: { pointer?: boolean } = {}): Promise<Json> {
  const authorized = nextMessage(room.helper, 'helper-session-authorized');
  const pointerBox = room.controller.getByRole('checkbox', { name: /Pointer/ });
  if (!extra.pointer && (await pointerBox.count()) > 0) await setCheckbox(pointerBox, false);
  await setCheckbox(clipboardBox(room.controller), true);
  await room.controller.getByRole('button', { name: 'Request control' }).click();
  await expect(dialog(room.sharer)).toBeVisible();
  // Informed consent: the clipboard is described and starts unchecked.
  await expect(dialog(room.sharer)).toContainText('You approve every read of your clipboard');
  await expect(clipboardBox(room.sharer)).toHaveAttribute('aria-checked', 'false');
  if (!extra.pointer)
    await expect(room.sharer.getByRole('button', { name: 'Allow' })).toBeDisabled();
  await setCheckbox(clipboardBox(room.sharer), true);
  if (extra.pointer)
    await expect(room.sharer.getByRole('checkbox', { name: /Pointer/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  await room.sharer.getByRole('button', { name: 'Allow' }).click();
  await expect(room.controller.getByText('Control granted')).toBeVisible();
  return authorized;
}

function nextMessage(helper: FakeHelper, type: string): Promise<Json> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}.`)), 10_000);
    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as Json;
      if (message['type'] !== type) return;
      clearTimeout(timeout);
      helper.socket.off('message', onMessage);
      resolve(message);
    };
    helper.socket.on('message', onMessage);
  });
}

async function setClipboard(page: Page, text: string): Promise<void> {
  await page.bringToFront();
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

async function readClipboard(page: Page): Promise<string> {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

test('clipboard consent and transfer: opt-in scope, manual send, approved read, revocation', async ({
  browser,
}) => {
  const room = await startRoom(browser, { scopes: ['pointer', 'clipboard'] });
  const { sharer, controller, helper } = room;
  try {
    await expect(controller.getByText('Available: pointer · clipboard')).toBeVisible();

    // 1. A default request never includes the clipboard, so a pointer grant cannot reach it.
    await expect(clipboardBox(controller)).toHaveAttribute('aria-checked', 'false');
    await controller.getByRole('button', { name: 'Request control' }).click();
    await expect(dialog(sharer)).toContainText('pointer');
    await expect(dialog(sharer)).not.toContainText('Clipboard');
    const pointerGrant = nextMessage(helper, 'helper-session-authorized');
    await sharer.getByRole('button', { name: 'Allow' }).click();
    expect((((await pointerGrant)['session'] as Json)['scopes'] as string[]).sort()).toEqual([
      'pointer',
    ]);
    await expect(controller.getByText('Control granted')).toBeVisible();
    await expect(controller.getByRole('button', { name: 'Send my clipboard text' })).toHaveCount(0);
    await controller.evaluate(() => {
      const channel = (window as unknown as { __dxChannels: Record<string, RTCDataChannel> })
        .__dxChannels['duplex-input'];
      // A hostile page forging a write under a pointer-only grant.
      channel?.send(
        JSON.stringify({
          type: 'clipboard-write',
          protocolVersion: 1,
          controlSessionId: crypto.randomUUID(),
          surfaceId: crypto.randomUUID(),
          sequence: 1,
          transferId: crypto.randomUUID(),
          text: 'forged',
        }),
      );
    });
    await controller.waitForTimeout(400);
    expect(helper.of('helper-clipboard-write')).toHaveLength(0);
    await controller.getByRole('button', { name: 'Release control' }).click();
    await expect(controller.getByText('Control granted')).toHaveCount(0);

    // 2. Clipboard-only grant: explicit opt-in on both sides.
    await controller.evaluate(() => {
      (window as never as { __dxSent: string[] }).__dxSent.length = 0;
    });
    const authorized = await grantClipboard(room);
    const session = authorized['session'] as { controlSessionId: string; scopes: string[] };
    expect(session.scopes).toEqual(['clipboard']);
    await expect(sharer.getByText('Peer has control permission')).toBeVisible();

    // Nothing is read until the controller clicks.
    await expect(controller.getByRole('button', { name: 'Send my clipboard text' })).toBeVisible();
    expect(
      await controller.evaluate(() => (window as never as { __dxSent: string[] }).__dxSent.length),
    ).toBe(0);

    // 3. Manual send: controller clipboard -> helper -> sharer's clipboard.
    await setClipboard(controller, 'Hello from the controller — ünïcode ✓\nsecond line');
    await controller.getByRole('button', { name: 'Send my clipboard text' }).click();
    await expect(controller.getByText(/Sent \d+ characters/)).toBeVisible();
    await expect(sharer.getByText(/put \d+ characters of text on your clipboard/)).toBeVisible();
    expect(helper.written).toEqual(['Hello from the controller — ünïcode ✓\nsecond line']);
    // The sharer's UI states the length but never the content.
    await expect(sharer.locator('body')).not.toContainText('Hello from the controller');
    const sentFrames = await controller.evaluate(
      () => (window as never as { __dxSent: string[] }).__dxSent,
    );
    expect(sentFrames).toHaveLength(1);

    // 4. A replay of the exact delivered frame, and forgeries, never reach the helper.
    await controller.waitForTimeout(700);
    const forged = (patch: Json): string =>
      JSON.stringify({ ...(JSON.parse(sentFrames[0] ?? '{}') as Json), ...patch });
    const inject = (payload: string): Promise<void> =>
      controller.evaluate((value) => {
        (window as never as { __dxChannels: Record<string, RTCDataChannel> }).__dxChannels[
          'duplex-input'
        ]?.send(value);
      }, payload);
    await inject(sentFrames[0] ?? '');
    await inject(
      forged({
        sequence: 99,
        transferId: crypto.randomUUID(),
        controlSessionId: crypto.randomUUID(),
      }),
    );
    await inject(
      forged({ sequence: 99, transferId: crypto.randomUUID(), surfaceId: crypto.randomUUID() }),
    );
    await inject(
      forged({
        sequence: 99,
        transferId: crypto.randomUUID(),
        text: 'x'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1),
      }),
    );
    await inject(forged({ sequence: 99, transferId: crypto.randomUUID(), text: 'bad\u0000text' }));
    await inject(forged({ sequence: 99, transferId: crypto.randomUUID(), extra: true }));
    await controller.waitForTimeout(500);
    expect(helper.of('helper-clipboard-write')).toHaveLength(1);

    // 5. Approved read: nothing reaches the helper until the sharer approves.
    await controller.getByRole('button', { name: 'Get remote clipboard text' }).click();
    const readDialog = sharer.getByRole('alertdialog', { name: 'Clipboard read request' });
    await expect(readDialog).toBeVisible();
    await controller.waitForTimeout(300);
    expect(helper.reads).toBe(0);
    await readDialog.getByRole('button', { name: 'Share once' }).click();
    await expect(controller.getByText(/Remote text ready \(\d+ characters\)/)).toBeVisible();
    expect(helper.reads).toBe(1);
    // Receiving does not touch the controller's clipboard; copying is a second explicit click.
    expect(await readClipboard(controller)).toContain('Hello from the controller');
    await controller.getByRole('button', { name: 'Copy to my clipboard' }).click();
    await expect(controller.getByText('Copied to your clipboard.')).toBeVisible();
    expect(await readClipboard(controller)).toBe(helper.clipboard);

    // 6. Declined read: the helper is never asked.
    await controller.waitForTimeout(700);
    await controller.getByRole('button', { name: 'Get remote clipboard text' }).click();
    await sharer
      .getByRole('alertdialog', { name: 'Clipboard read request' })
      .getByRole('button', { name: 'Decline' })
      .click();
    await expect(controller.getByRole('alert')).toContainText('declined');
    expect(helper.reads).toBe(1);

    // Positive control: the same injection path delivers a correct, fresh frame, so the drops
    // above were real rejections rather than a broken harness.
    await controller.waitForTimeout(700);
    await inject(forged({ sequence: 500, transferId: crypto.randomUUID(), text: 'fresh frame' }));
    await expect.poll(() => helper.written).toContain('fresh frame');
    expect(helper.of('helper-clipboard-write')).toHaveLength(2);

    // 7. Revocation: the controller loses the actions and a late write goes nowhere.
    const revoked = nextMessage(helper, 'helper-session-revoked');
    await sharer.getByRole('button', { name: 'Stop control' }).click();
    expect((await revoked)['controlSessionId']).toBe(session.controlSessionId);
    await expect(controller.getByText('Control granted')).toHaveCount(0);
    await expect(controller.getByRole('button', { name: 'Send my clipboard text' })).toHaveCount(0);
    await inject(forged({ sequence: 1000, transferId: crypto.randomUUID() }));
    await controller.waitForTimeout(400);
    expect(helper.of('helper-clipboard-write')).toHaveLength(2);
  } finally {
    await room.close();
  }
});

test('combined pointer and clipboard grants are independent and a rejection grants nothing', async ({
  browser,
}) => {
  const room = await startRoom(browser, { scopes: ['pointer', 'keyboard', 'clipboard'] });
  const { sharer, controller, helper } = room;
  try {
    await controller.getByRole('button', { name: 'Request control' }).click();
    await sharer.getByRole('button', { name: 'Reject' }).click();
    await expect(controller.getByText('Control granted')).toHaveCount(0);
    expect(helper.of('helper-session-authorized')).toHaveLength(0);

    const authorized = await grantClipboard(room, { pointer: true });
    expect(((authorized['session'] as Json)['scopes'] as string[]).sort()).toEqual([
      'clipboard',
      'keyboard',
      'pointer',
    ]);
    await expect(controller.getByRole('button', { name: 'Send my clipboard text' })).toBeVisible();
    await expect(
      controller.getByRole('button', { name: 'Get remote clipboard text' }),
    ).toBeVisible();
  } finally {
    await room.close();
  }
});

test('the clipboard is not offered when the helper cannot service it', async ({ browser }) => {
  const room = await startRoom(browser, { scopes: ['pointer'] });
  try {
    await expect(room.controller.getByText('Available: pointer')).toBeVisible();
    await expect(clipboardBox(room.controller)).toHaveCount(0);
  } finally {
    await room.close();
  }
});

test('browser clipboard permission denial is explained and nothing is sent', async ({
  browser,
}) => {
  const room = await startRoom(browser, {
    scopes: ['clipboard'],
    clipboardPermissions: false,
    controllerInit: () => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
          writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
        },
      });
    },
  });
  try {
    await setCheckbox(clipboardBox(room.controller), true);
    await grantClipboardFromChecked(room);
    await room.controller.getByRole('button', { name: 'Send my clipboard text' }).click();
    await expect(room.controller.getByRole('alert')).toContainText(
      'did not allow reading your clipboard',
    );
    expect(room.helper.of('helper-clipboard-write')).toHaveLength(0);
  } finally {
    await room.close();
  }
});

test('an unsupported browser clipboard is reported accurately', async ({ browser }) => {
  const room = await startRoom(browser, {
    scopes: ['clipboard'],
    controllerInit: () => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    },
  });
  try {
    await setCheckbox(clipboardBox(room.controller), true);
    await grantClipboardFromChecked(room);
    await expect(room.controller.getByText(/limits clipboard access/)).toBeVisible();
    await expect(
      room.controller.getByRole('button', { name: 'Send my clipboard text' }),
    ).toBeDisabled();
    await expect(
      room.controller.getByRole('button', { name: 'Get remote clipboard text' }),
    ).toBeDisabled();
  } finally {
    await room.close();
  }
});

test('a native clipboard failure is reported without exposing content', async ({ browser }) => {
  const room = await startRoom(browser, { scopes: ['clipboard'] });
  try {
    room.helper.writeOutcome = 'denied';
    await grantClipboard(room);
    await setClipboard(room.controller, 'cannot be written');
    await room.controller.getByRole('button', { name: 'Send my clipboard text' }).click();
    await expect(room.controller.getByRole('alert')).toContainText('refused');
    await expect(room.sharer.getByText(/put \d+ characters/)).toHaveCount(0);
    expect(room.helper.written).toEqual([]);
  } finally {
    await room.close();
  }
});

test('losing the peer or the helper ends the clipboard session', async ({ browser }) => {
  const room = await startRoom(browser, { scopes: ['clipboard'] });
  try {
    await grantClipboard(room);
    const revoked = nextMessage(room.helper, 'helper-session-revoked');
    await room.controller.close();
    expect((await revoked)['type']).toBe('helper-session-revoked');
    await expect(room.sharer.getByText('Peer has control permission')).toHaveCount(0);
  } finally {
    await room.close();
  }
});

/** The controller already ticked the clipboard; ask for it and have the sharer opt in. */
async function grantClipboardFromChecked(room: Room): Promise<void> {
  await room.controller.getByRole('button', { name: 'Request control' }).click();
  await expect(dialog(room.sharer)).toBeVisible();
  await setCheckbox(clipboardBox(room.sharer), true);
  await room.sharer.getByRole('button', { name: 'Allow' }).click();
  await expect(room.controller.getByText('Control granted')).toBeVisible();
}
