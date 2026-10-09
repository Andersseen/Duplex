// Analog adds `x-analog-no-ssr` / `x-analog-no-streaming` to every Nitro route rule, with the
// value `undefined` when they do not apply. Nitro then writes them into the Cloudflare `_headers`
// file as the literal text "undefined", which Cloudflare would serve as a header value.
import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node clean-headers.mjs <path to _headers>');
  process.exit(1);
}
let text;
try {
  text = await readFile(file, 'utf8');
} catch {
  console.log(`No ${file} generated; nothing to clean.`);
  process.exit(0);
}
const kept = text.split('\n').filter((line) => !/^\s+x-analog-[\w-]+:\s*undefined\s*$/.test(line));
await writeFile(file, kept.join('\n').replace(/\n*$/, '\n'));
console.log(`Cleaned ${text.split('\n').length - kept.length} placeholder header(s) from ${file}.`);
