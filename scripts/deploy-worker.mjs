import { spawnSync } from 'node:child_process';

const allowedOrigins = process.env.ALLOWED_ORIGINS?.trim();
if (!allowedOrigins) {
  console.error(
    'Set ALLOWED_ORIGINS to the comma-separated production web origins before deploying.',
  );
  process.exit(1);
}
const origins = allowedOrigins.split(',').map((origin) => origin.trim());
if (
  origins.some((origin) => {
    try {
      const url = new URL(origin);
      return url.protocol !== 'https:' || url.origin !== origin;
    } catch {
      return true;
    }
  })
) {
  console.error('ALLOWED_ORIGINS must contain exact HTTPS origins with no path or trailing slash.');
  process.exit(1);
}

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'deploy',
    '--config',
    'wrangler.jsonc',
    '--var',
    `ALLOWED_ORIGINS:${allowedOrigins}`,
  ],
  { stdio: 'inherit', env: process.env },
);
process.exit(result.status ?? 1);
