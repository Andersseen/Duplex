import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const localVars = await readFile('apps/worker/.dev.vars', 'utf8').catch(() => '');
const values = new Map(
  localVars
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, '')]),
);
const missing = ['TURN_KEY_ID', 'TURN_KEY_API_TOKEN'].filter((name) => !values.get(name));
if (missing.length) {
  console.error(`TURN E2E requires ${missing.join(' and ')} in apps/worker/.dev.vars.`);
  process.exit(1);
}

const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--grep', 'forced relay'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DUPLEX_E2E_TURN: 'true',
    VITE_DUPLEX_FORCE_RELAY: 'true',
  },
});
process.exit(result.status ?? 1);
