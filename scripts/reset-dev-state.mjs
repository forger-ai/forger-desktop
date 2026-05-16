#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const yes = process.argv.includes('--yes');
const paths = [
  join(homedir(), 'Library', 'Application Support', 'forger-desktop-dev'),
  join(homedir(), 'Forger-dev'),
];

console.log('Forger Desktop dev state reset');
console.log('This removes only local dev runtime state. Source repositories are not touched.');
for (const target of paths) {
  console.log(`- ${target}`);
}

if (!yes) {
  console.log('\nDry run only. Re-run with --yes to delete these paths.');
  process.exit(0);
}

for (const target of paths) {
  await rm(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}
