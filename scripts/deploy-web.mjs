import { spawnSync } from 'node:child_process';

const apiOrigin = process.env.VITE_DUPLEX_API_ORIGIN?.trim();
if (!apiOrigin) {
  console.error(
    'Set VITE_DUPLEX_API_ORIGIN to the deployed signaling Worker origin before deploying.',
  );
  process.exit(1);
}
try {
  const url = new URL(apiOrigin);
  if (url.protocol !== 'https:' || url.origin !== apiOrigin) throw new Error('invalid origin');
} catch {
  console.error('VITE_DUPLEX_API_ORIGIN must be an HTTPS origin with no path or trailing slash.');
  process.exit(1);
}

const build = spawnSync('pnpm', ['build:cloudflare'], { stdio: 'inherit', env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);
const deploy = spawnSync(
  'pnpm',
  ['--filter', '@duplex/worker', 'exec', 'wrangler', 'deploy', '--config', '../web/wrangler.jsonc'],
  { stdio: 'inherit', env: process.env },
);
process.exit(deploy.status ?? 1);
