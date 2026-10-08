import { z } from 'zod';

export const TURN_CREDENTIAL_TTL_SECONDS = 12 * 60 * 60;
export const CLOUDFLARE_STUN_SERVER = 'stun:stun.cloudflare.com:3478';

const iceServerSchema = z
  .object({
    urls: z.union([z.string().min(1), z.array(z.string().min(1).max(512)).min(1).max(16)]),
    username: z.string().min(1).max(256).optional(),
    credential: z.string().min(1).max(512).optional(),
  })
  .strict();

/** Cloudflare's generate-ice-servers response, validated before any fields are trusted. */
export const cloudflareIceServersResponseSchema = z
  .object({ iceServers: z.array(iceServerSchema).min(1).max(8) })
  .strict();

export interface RtcConfigurationResult {
  readonly iceServers: {
    readonly urls: string | string[];
    readonly username?: string;
    readonly credential?: string;
  }[];
  readonly expiresAt: number;
  readonly relayAvailable: boolean;
}

function validCloudflareIceServers(input: unknown): RtcConfigurationResult['iceServers'] | null {
  const parsed = cloudflareIceServersResponseSchema.safeParse(input);
  if (!parsed.success) return null;
  const servers = parsed.data.iceServers;
  let hasCloudflareStun = false;
  let hasAuthenticatedTurn = false;
  for (const server of servers) {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    for (const url of urls) {
      if (url === CLOUDFLARE_STUN_SERVER || url === 'stun:stun.cloudflare.com') {
        hasCloudflareStun = true;
        continue;
      }
      if (!/^turns?:turn\.cloudflare\.com:\d+\?transport=(udp|tcp)$/.test(url)) return null;
      if (!server.username || !server.credential) return null;
      hasAuthenticatedTurn = true;
    }
  }
  return hasCloudflareStun && hasAuthenticatedTurn
    ? servers.map((server) => ({
        urls: server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(server.credential ? { credential: server.credential } : {}),
      }))
    : null;
}

export function unavailableRtcConfiguration(now = Date.now()): RtcConfigurationResult {
  return {
    iceServers: [{ urls: CLOUDFLARE_STUN_SERVER }],
    expiresAt: now + TURN_CREDENTIAL_TTL_SECONDS * 1000,
    relayAvailable: false,
  };
}

export async function generateRtcConfiguration(
  env: Pick<Cloudflare.Env, 'TURN_KEY_ID' | 'TURN_KEY_API_TOKEN'>,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RtcConfigurationResult> {
  const { TURN_KEY_ID: keyId, TURN_KEY_API_TOKEN: apiToken } = env;
  if (!keyId || !apiToken) return unavailableRtcConfiguration(now);

  const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.warn('TURN credential generation failed.', { status: response.status });
      return unavailableRtcConfiguration(now);
    }
    const servers = validCloudflareIceServers(await response.json());
    if (!servers) {
      console.warn('TURN credential response did not match the expected schema.');
      return unavailableRtcConfiguration(now);
    }
    return {
      iceServers: servers,
      expiresAt: now + TURN_CREDENTIAL_TTL_SECONDS * 1000,
      relayAvailable: true,
    };
  } catch (error) {
    console.warn('TURN credential generation request failed.', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return unavailableRtcConfiguration(now);
  }
}
