import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { collectLocalHardware } = require('../../dist-electron/main/local-development/hardware.js');
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

if (process.argv.slice(2).some((argument) => !argument.startsWith('--directory='))) {
  throw new Error('Usage: node scripts/local-development/inspect-hardware.mjs [--directory=/existing/path]');
}
const directory = process.argv.slice(2).find((argument) => argument.startsWith('--directory='))?.slice(12) || desktopRoot;
process.stdout.write(`${JSON.stringify(await collectLocalHardware(directory), null, 2)}\n`);
