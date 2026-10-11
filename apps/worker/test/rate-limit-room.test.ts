import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { PROTOCOL_VERSION, createRoomId } from '@duplex/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { CallRoom } from '../src/call-room';
import { RATE_LIMIT_CLOSE_CODE } from '../src/rate-limit';

interface Message {
  type: string;
  payload?: Record<string, unknown>;
}
// Floods push hundreds of messages through Zod; instrumented coverage runs need the headroom.
vi.setConfig({ testTimeout: 30_000 });

const development = { ...env, ENVIRONMENT: 'development' } as Cloudflare.Env;

/** Generous bound: Istanbul-instrumented coverage runs are several times slower than plain runs. */
const eventually = (assertion: () => void): Promise<void> =>
  vi.waitFor(assertion, { timeout: 10_000 });

interface Client {
  socket: WebSocket;
  messages: Message[];
  closed: Promise<number>;
}

function wrap(socket: WebSocket): Client {
  const messages: Message[] = [];
  socket.addEventListener('message', (event) => {
    messages.push(JSON.parse(String(event.data)) as Message);
  });
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
  return { socket, messages, closed };
}

async function connect(roomId: string): Promise<Client> {
  const response = await app.request(
    `/api/rooms/${roomId}/ws`,
    { headers: { Upgrade: 'websocket' } },
    development,
  );
  const socket = (response as Response & { webSocket: WebSocket }).webSocket;
  socket.accept();
  return wrap(socket);
}

const seen = (client: Client, type: string): number =>
  client.messages.filter((message) => message.type === type).length;

async function joined(roomId: string): Promise<Client> {
  const client = await connect(roomId);
  client.socket.send(
    JSON.stringify({ type: 'join', payload: { roomId, protocolVersion: PROTOCOL_VERSION } }),
  );
  await eventually(() => {
    expect(seen(client, 'rtc-config')).toBe(1);
  });
  return client;
}

const candidate = (index: number): string =>
  JSON.stringify({
    type: 'ice-candidate',
    payload: {
      candidate: {
        candidate: `candidate:${String(index)} 1 udp 1 10.0.0.1 9 typ host`,
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    },
  });

/**
 * Replaces the room's rate-limit clock with a controllable one, so no test depends on how fast
 * workerd (or Istanbul instrumentation) happens to process messages.
 */
async function freezeClock(roomId: string): Promise<{ advance(ms: number): void }> {
  let now = 1_000;
  const stub = env.CALL_ROOM.get(env.CALL_ROOM.idFromName(roomId));
  await runInDurableObject(stub, (instance: CallRoom) => {
    instance.rateLimitClock = () => now;
  });
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}

async function room(): Promise<{
  roomId: string;
  owner: Client;
  peer: Client;
  time: { advance(ms: number): void };
}> {
  const roomId = createRoomId();
  const time = await freezeClock(roomId);
  const owner = await joined(roomId);
  const peer = await joined(roomId);
  return { roomId, owner, peer, time };
}

async function pairHelper(roomId: string, owner: Client): Promise<Client> {
  const earlier = seen(owner, 'helper-paired');
  const created = seen(owner, 'helper-pairing-created');
  owner.socket.send(JSON.stringify({ type: 'helper-pairing-create', payload: {} }));
  await eventually(() => {
    expect(seen(owner, 'helper-pairing-created')).toBe(created + 1);
  });
  const issued = owner.messages.findLast((m) => m.type === 'helper-pairing-created');
  const token = String(issued?.payload?.['token']);
  const response = await app.request(
    `/api/rooms/${roomId}/helper/ws`,
    { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } },
    { ...env, ENVIRONMENT: 'production' },
  );
  const socket = (response as Response & { webSocket: WebSocket }).webSocket;
  socket.accept();
  const helper = wrap(socket);
  await eventually(() => {
    expect(seen(owner, 'helper-paired')).toBe(earlier + 1);
  });
  return helper;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CallRoom participant rate limiting', () => {
  it('relays a normal signaling exchange and a full ICE candidate burst', async () => {
    const { owner, peer } = await room();
    for (let i = 0; i < 60; i += 1) owner.socket.send(candidate(i));
    await eventually(() => {
      expect(seen(peer, 'ice-candidate')).toBe(60);
    });
    expect(owner.socket.readyState).toBe(WebSocket.OPEN);
    owner.socket.close();
    peer.socket.close();
  });

  it('refills the budget as time passes, so a spent connection recovers', async () => {
    const { owner, peer, time } = await room();
    // The join spent one of the 100 signaling tokens; this spends the other 99 at a frozen instant.
    for (let i = 0; i < 99; i += 1) owner.socket.send(candidate(i));
    await eventually(() => {
      expect(seen(peer, 'ice-candidate')).toBe(99);
    });
    time.advance(1000);
    for (let i = 0; i < 10; i += 1) owner.socket.send(candidate(i));
    await eventually(() => {
      expect(seen(peer, 'ice-candidate')).toBe(109);
    });
    expect(owner.socket.readyState).toBe(WebSocket.OPEN);
    owner.socket.close();
    peer.socket.close();
  });

  it('closes a participant that floods the room and notifies the peer', async () => {
    const { owner, peer } = await room();
    for (let i = 0; i < 400; i += 1) owner.socket.send(candidate(i));
    expect(await owner.closed).toBe(RATE_LIMIT_CLOSE_CODE);
    await eventually(() => {
      expect(seen(peer, 'peer-left')).toBe(1);
    });
    // Over-limit messages are dropped, never relayed in bulk.
    expect(seen(peer, 'ice-candidate')).toBeLessThan(400);
    peer.socket.close();
  });

  it('counts malformed, binary and unknown frames instead of letting them dodge the limit', async () => {
    for (const frame of [
      () => '{not json',
      () => JSON.stringify({ type: 'who-knows', payload: {} }),
      () => new Uint8Array(8).buffer,
    ]) {
      const { owner, peer } = await room();
      for (let i = 0; i < 2000 && owner.socket.readyState === WebSocket.OPEN; i += 1)
        owner.socket.send(frame());
      const code = await owner.closed;
      expect([1007, 1008, 1009, RATE_LIMIT_CLOSE_CODE]).toContain(code);
      expect(seen(peer, 'ice-candidate')).toBe(0);
      peer.socket.close();
    }
  });

  it('isolates connections: one flooding participant does not throttle another', async () => {
    const { owner, peer } = await room();
    for (let i = 0; i < 400; i += 1) owner.socket.send(candidate(i));
    expect(await owner.closed).toBe(RATE_LIMIT_CLOSE_CODE);
    const before = seen(peer, 'peer-left');
    for (let i = 0; i < 50; i += 1) peer.socket.send(candidate(i));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    expect(seen(peer, 'peer-left')).toBe(before);
    peer.socket.close();
  });

  it('starts a reconnecting participant with a fresh budget', async () => {
    const roomId = createRoomId();
    await freezeClock(roomId);
    const first = await joined(roomId);
    for (let i = 0; i < 400; i += 1) first.socket.send(candidate(i));
    expect(await first.closed).toBe(RATE_LIMIT_CLOSE_CODE);
    const second = await joined(roomId);
    const peer = await joined(roomId);
    for (let i = 0; i < 60; i += 1) second.socket.send(candidate(i));
    await eventually(() => {
      expect(seen(peer, 'ice-candidate')).toBe(60);
    });
    second.socket.close();
    peer.socket.close();
  });

  it('keeps delivering revocation while the same connection is being throttled', async () => {
    const { roomId, owner, peer } = await room();
    const helper = await pairHelper(roomId, owner);
    // Exhaust the signaling budget and then some, without reaching the close threshold.
    for (let i = 0; i < 115; i += 1) owner.socket.send(candidate(i));
    const revoke = {
      type: 'helper-session-revoked',
      controlSessionId: crypto.randomUUID(),
      reason: 'user',
    };
    owner.socket.send(JSON.stringify(revoke));
    await eventually(() => {
      expect(helper.messages.some((m) => m.type === 'helper-session-revoked')).toBe(true);
    });
    expect(owner.socket.readyState).toBe(WebSocket.OPEN);
    helper.socket.close();
    owner.socket.close();
    peer.socket.close();
  });

  it('relays legitimate clipboard operations and never logs clipboard text', async () => {
    const warn = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    const { roomId, owner, peer } = await room();
    const helper = await pairHelper(roomId, owner);
    const secret = 'correct-horse-battery-staple';
    const ids = {
      controlSessionId: crypto.randomUUID(),
      surfaceId: crypto.randomUUID(),
      transferId: crypto.randomUUID(),
    };
    owner.socket.send(JSON.stringify({ type: 'helper-clipboard-write', ...ids, text: secret }));
    owner.socket.send(JSON.stringify({ type: 'helper-clipboard-read', ...ids }));
    await eventually(() => {
      expect(helper.messages.map((m) => m.type)).toEqual([
        'helper-clipboard-write',
        'helper-clipboard-read',
      ]);
    });
    // Flood the clipboard category past its budget until the connection is closed.
    for (let i = 0; i < 200 && owner.socket.readyState === WebSocket.OPEN; i += 1)
      owner.socket.send(JSON.stringify({ type: 'helper-clipboard-write', ...ids, text: secret }));
    expect(await owner.closed).toBe(RATE_LIMIT_CLOSE_CODE);
    expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toContain(secret);
    helper.socket.close();
    peer.socket.close();
  });

  it('still enforces the message size bounds under the limiter', async () => {
    const { owner, peer } = await room();
    owner.socket.send(candidate(1) + ' '.repeat(129 * 1024));
    expect(await owner.closed).toBe(1009);
    expect(seen(peer, 'ice-candidate')).toBe(0);
    peer.socket.close();
  });
});

describe('CallRoom helper rate limiting', () => {
  it('closes a flooding helper, tells its owner, and lets the helper re-pair', async () => {
    const { roomId, owner, peer } = await room();
    const helper = await pairHelper(roomId, owner);
    const capabilities = JSON.stringify({
      type: 'helper-capabilities',
      availableScopes: ['pointer'],
    });
    for (let i = 0; i < 300 && helper.socket.readyState === WebSocket.OPEN; i += 1)
      helper.socket.send(capabilities);
    expect(await helper.closed).toBe(RATE_LIMIT_CLOSE_CODE);
    await eventually(() => {
      expect(seen(owner, 'helper-disconnected')).toBe(1);
    });
    const next = await pairHelper(roomId, owner);
    expect(next.socket.readyState).toBe(WebSocket.OPEN);
    next.socket.close();
    owner.socket.close();
    peer.socket.close();
  });

  it('forwards helper Stop while the helper status budget is exhausted', async () => {
    const { roomId, owner, peer } = await room();
    const helper = await pairHelper(roomId, owner);
    const capabilities = JSON.stringify({
      type: 'helper-capabilities',
      availableScopes: ['pointer'],
    });
    for (let i = 0; i < 40; i += 1) helper.socket.send(capabilities);
    const stop = { type: 'helper-stop-control', controlSessionId: crypto.randomUUID() };
    helper.socket.send(JSON.stringify(stop));
    await eventually(() => {
      expect(owner.messages.some((m) => m.type === 'helper-stop-control')).toBe(true);
    });
    expect(helper.socket.readyState).toBe(WebSocket.OPEN);
    helper.socket.close();
    owner.socket.close();
    peer.socket.close();
  });

  it('closes a helper that floods malformed frames', async () => {
    const { roomId, owner, peer } = await room();
    const helper = await pairHelper(roomId, owner);
    for (let i = 0; i < 300 && helper.socket.readyState === WebSocket.OPEN; i += 1)
      helper.socket.send('{bad');
    expect([1008, RATE_LIMIT_CLOSE_CODE]).toContain(await helper.closed);
    owner.socket.close();
    peer.socket.close();
  });
});
