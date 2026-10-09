# Deployment

Duplex deploys two independent Cloudflare Workers:

- `apps/worker`: Hono signaling API and the existing `CallRoom` Durable Object.
- `apps/web`: Analog SSR app built with Nitro's `cloudflare_module` preset.

Build and deployment are separate. `pnpm build` never deploys. `pnpm deploy` deploys the signaling Worker first, then the web Worker.

## Cloudflare prerequisites

You need a Cloudflare account with Workers enabled, a Workers API token with permission to deploy both Workers, and an account ID. Attach the desired hostnames to the deployed Workers in Cloudflare. The user-facing hostname can be `call.andersseen.dev`; keep the signaling hostname configurable and provide its HTTPS origin as `VITE_DUPLEX_API_ORIGIN`.

Create a Realtime TURN key in the Cloudflare dashboard or through Cloudflare's TURN key API. Store its key ID and API token as secrets on the signaling Worker:

```bash
cd apps/worker
pnpm exec wrangler secret put TURN_KEY_ID
pnpm exec wrangler secret put TURN_KEY_API_TOKEN
```

Wrangler prompts for each value. Do not put these values in Vite variables, `.env` files consumed by the web build, source code, room links, or signaling messages. The Worker calls Cloudflare's [credential generation endpoint](https://developers.cloudflare.com/realtime/turn/generate-credentials/) and sends only the generated expiring ICE username and credential to joined participants.

Cloudflare documents a maximum credential TTL of 48 hours. Duplex requests credentials for 12 hours and refreshes them one hour before expiry through the joined WebSocket. The Durable Object stores the last issuance time in the WebSocket attachment and permits at most one refresh per participant each minute. If Cloudflare is unavailable, calls receive Cloudflare STUN only and can still establish direct connectivity.

## Worker configuration

Set the production browser origin in `ALLOWED_ORIGINS`. Supply a comma-separated list of exact origins with no path or trailing slash. For example:

```text
https://call.andersseen.dev
```

The `deploy:worker` script requires this variable and passes it to Wrangler as a Worker variable. Production WebSocket upgrades require an exact match. Local `pnpm dev` explicitly uses development mode and accepts localhost origins.

For local TURN testing, create `apps/worker/.dev.vars` (ignored by Git) with the two TURN secret names. `pnpm dev` also works without that file and then uses STUN only.

## Web/API configuration

`VITE_DUPLEX_API_ORIGIN` is a public build-time value containing the HTTPS origin of the signaling Worker, for example `https://api.example.com`. It contains no secrets. The web deployment script requires it so a production build cannot silently use the web host for signaling. Local development leaves it unset and uses the Vite proxy to `localhost:8787`.

## Deploy from a workstation

After authenticating Wrangler with `pnpm exec wrangler login`, provide the account ID and the two public deployment values in the shell, then run:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-cloudflare-account-id"
export ALLOWED_ORIGINS="https://call.andersseen.dev"
export VITE_DUPLEX_API_ORIGIN="https://api.example.com"
pnpm deploy
```

The Worker deployment preserves the existing `CALL_ROOM` binding and `v1` SQLite Durable Object migration. It does not create or rename a Durable Object class. Configure `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` directly on the deployed Worker as secrets; deployment does not upload them.

## Manual GitHub deployment

The **Deploy production** workflow is started with `workflow_dispatch`. It calls the same CI workflow used for pull requests, including Playwright and Rust checks, then deploys `duplex-worker` and `duplex-web` in that order.

Configure these repository settings before starting it:

| Setting                  | Kind     | Value                                           |
| ------------------------ | -------- | ----------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`   | Secret   | Token authorized to deploy Workers              |
| `CLOUDFLARE_ACCOUNT_ID`  | Secret   | Cloudflare account ID                           |
| `ALLOWED_ORIGINS`        | Variable | Exact production web origin(s), comma-separated |
| `VITE_DUPLEX_API_ORIGIN` | Variable | Public HTTPS signaling Worker origin            |

Configure the TURN secrets directly on the deployed Worker once using Wrangler or the Cloudflare dashboard. The GitHub workflow never builds them into the browser app.

## Security headers

The web Worker ships `Content-Security-Policy`, `Permissions-Policy`, `Strict-Transport-Security`,
`X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy` (see
[docs/security.md](./docs/security.md#web-security-headers)). They are generated at build time from
`apps/web/vite.config.ts`; the CSP `connect-src` is derived from `VITE_DUPLEX_API_ORIGIN`, which is
why the web build and the signaling origin must agree. After changing either, run:

```bash
pnpm e2e:production
```

This builds the production Worker output, serves it with Wrangler against a local signaling Worker,
and fails on any missing header or CSP violation while a real two-browser call runs.

## Verify a real relay

Normal `pnpm e2e` uses local signaling and fake browser devices. It does not require a TURN key and may connect directly.

For an opt-in relay test, configure `apps/worker/.dev.vars` with the real key ID and API token, install Chromium with `pnpm exec playwright install chromium`, and run:

```bash
pnpm e2e:turn
```

This starts an isolated local Worker and Vite server, enables the development-only relay policy, opens two Chromium contexts, and checks that both select a relay candidate. It exits before starting if either TURN secret is missing. Forced relay is gated by Vite development mode; production query parameters cannot change ICE transport policy.

You need Cloudflare account access to create the TURN key, set deployed Worker secrets, and run a real relay test. Those account operations cannot be completed from a local checkout without Cloudflare credentials.
