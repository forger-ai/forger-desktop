import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const electronBuildDir = resolve('dist-electron');

await rm(electronBuildDir, { force: true, recursive: true });
