// Prerendered pages are served by Cloudflare static assets without running the Worker, so their
// inline-script hashes must be written into the `_headers` file after the build.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addScriptHashes, angularInlineScriptHashes } from '../apps/web/src/server/csp.ts';

const publicDir = process.argv[2];
if (!publicDir) {
  console.error('Usage: node apply-static-csp.mjs <public output directory>');
  process.exit(1);
}

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

const hashes = new Set();
for await (const file of htmlFiles(publicDir))
  for (const hash of await angularInlineScriptHashes(await readFile(file, 'utf8')))
    hashes.add(hash);

const headersFile = join(publicDir, '_headers');
const lines = (await readFile(headersFile, 'utf8')).split('\n');
let patched = 0;
const result = lines.map((line) => {
  const match = line.match(/^(\s+)Content-Security-Policy:\s*(.+)$/i);
  if (!match) return line;
  patched += 1;
  return `${match[1]}Content-Security-Policy: ${addScriptHashes(match[2], [...hashes].sort())}`;
});
if (patched === 0) {
  console.error(`No Content-Security-Policy header found in ${headersFile}.`);
  process.exit(1);
}
await writeFile(headersFile, result.join('\n'));
console.log(`Added ${hashes.size} inline-script hash(es) to ${patched} CSP header(s).`);
