import { describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_STUN_SERVER,
  TURN_CREDENTIAL_TTL_SECONDS,
  generateRtcConfiguration,
} from '../src/rtc-config';

const validResponse = {
  iceServers: [
    { urls: [CLOUDFLARE_STUN_SERVER] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:443?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'short-lived-user',
      credential: 'short-lived-password',
    },
  ],
};

describe('generateRtcConfiguration', () => {
  it('validates and returns Cloudflare ICE servers with a bounded expiry', async () => {
    let requestUrl: RequestInfo | URL | undefined;
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      requestUrl = input;
      requestInit = init;
      return Promise.resolve(Response.json(validResponse, { status: 201 }));
    });
    const result = await generateRtcConfiguration(
      { TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: 'test-api-token' },
      fetcher,
      1_000,
    );
    expect(result).toEqual({
      iceServers: validResponse.iceServers,
      expiresAt: 1_000 + TURN_CREDENTIAL_TTL_SECONDS * 1000,
      relayAvailable: true,
    });
    expect(requestUrl).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/test-key/credentials/generate-ice-servers',
    );
    expect(requestInit?.method).toBe('POST');
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe('Bearer test-api-token');
    expect(requestInit?.body).toBe(JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }));
    expect(JSON.stringify(result)).not.toContain('test-api-token');
  });

  it('uses Cloudflare STUN when local TURN secrets are absent', async () => {
    const fetcher = vi.fn();
    const result = await generateRtcConfiguration({}, fetcher, 1_000);
    expect(result).toMatchObject({
      iceServers: [{ urls: CLOUDFLARE_STUN_SERVER }],
      relayAvailable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  const failures: [string, typeof fetch][] = [
    ['upstream error', () => Promise.resolve(new Response(null, { status: 503 }))],
    [
      'malformed JSON shape',
      () => Promise.resolve(Response.json({ iceServers: [{ urls: 'turn:bad.test' }] })),
    ],
    ['network failure', async () => Promise.reject(new TypeError('network down'))],
  ];

  it.each(failures)('degrades to STUN on %s', async (_label, fetchImpl) => {
    const result = await generateRtcConfiguration(
      { TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: 'test-api-token' },
      vi.fn(fetchImpl),
      1_000,
    );
    expect(result).toMatchObject({
      iceServers: [{ urls: CLOUDFLARE_STUN_SERVER }],
      relayAvailable: false,
    });
  });

  it.each([
    [
      'TURN servers on a foreign host',
      [
        { urls: [CLOUDFLARE_STUN_SERVER] },
        { urls: 'turn:turn.evil.test:3478?transport=udp', username: 'u', credential: 'c' },
      ],
    ],
    [
      'TURN servers without credentials',
      [{ urls: [CLOUDFLARE_STUN_SERVER] }, { urls: 'turn:turn.cloudflare.com:3478?transport=udp' }],
    ],
    [
      'a response with no STUN server',
      [{ urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', credential: 'c' }],
    ],
    ['a response with no TURN server', [{ urls: [CLOUDFLARE_STUN_SERVER] }]],
  ])('refuses %s and falls back to STUN', async (_label, iceServers) => {
    const result = await generateRtcConfiguration(
      { TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: 'test-api-token' },
      vi.fn(() => Promise.resolve(Response.json({ iceServers }))),
      1_000,
    );

    expect(result.relayAvailable).toBe(false);
    expect(result.iceServers).toEqual([{ urls: CLOUDFLARE_STUN_SERVER }]);
  });

  it('never writes the TURN API token or credentials to the logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await generateRtcConfiguration(
        { TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: 'secret-api-token' },
        vi.fn(() => Promise.reject(new Error('failed with Bearer secret-api-token'))),
        1_000,
      );
      await generateRtcConfiguration(
        { TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: 'secret-api-token' },
        vi.fn(() => Promise.resolve(Response.json(validResponse, { status: 500 }))),
        1_000,
      );

      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-api-token');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('short-lived-password');
    } finally {
      warn.mockRestore();
    }
  });
});
