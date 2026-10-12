import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const generatedDocs = resolve(root, 'dist');
const publishedDocs = resolve(root, 'apps/web/public/docs');

const build = spawnSync('pnpm', ['exec', 'entwine', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (build.status !== 0) process.exit(build.status ?? 1);
if (!existsSync(generatedDocs)) {
  console.error(`Entwine did not create ${generatedDocs}`);
  process.exit(1);
}

rmSync(publishedDocs, { recursive: true, force: true });
mkdirSync(publishedDocs, { recursive: true });
cpSync(generatedDocs, publishedDocs, { recursive: true });
console.log(`Published Entwine docs to ${publishedDocs}`);
