// Syntax-check every JavaScript module in the project.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = ['src', 'netlify', 'tests', 'scripts'];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.js') || full.endsWith('.mjs')) files.push(full);
  }
}

for (const root of roots) {
  try {
    walk(root);
  } catch {
    /* folder may not exist yet */
  }
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    process.stderr.write(`\n${file}\n${err.stderr?.toString() || err.message}\n`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`Syntax check passed for ${files.length} files.`);
