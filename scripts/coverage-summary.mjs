// Prints a Markdown table of per-package coverage from the json-summary reports written by
// `pnpm test:coverage`. In CI the output is appended to the job summary.
import { readFile } from 'node:fs/promises';

const REPORTS = [
  ['@duplex/protocol', 'packages/protocol/coverage/coverage-summary.json'],
  ['@duplex/webrtc', 'packages/webrtc/coverage/coverage-summary.json'],
  ['@duplex/worker', 'apps/worker/coverage/coverage-summary.json'],
  ['@duplex/web', 'apps/web/coverage/coverage-summary.json'],
  ['@duplex/helper', 'apps/helper/coverage/helper/coverage-summary.json'],
];

const pct = (metric) => `${metric.pct.toFixed(1)}%`;
const rows = [];
for (const [name, file] of REPORTS) {
  try {
    const { total } = JSON.parse(await readFile(file, 'utf8'));
    rows.push(
      `| ${name} | ${pct(total.statements)} | ${pct(total.branches)} | ${pct(total.functions)} | ${pct(total.lines)} |`,
    );
  } catch {
    rows.push(`| ${name} | n/a | n/a | n/a | n/a |`);
  }
}
console.log(
  [
    '### Test coverage',
    '',
    '| Package | Statements | Branches | Functions | Lines |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows,
  ].join('\n'),
);
