#!/usr/bin/env node

import { downloadArtifact } from '@electron/get';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const electronRoot = path.join(root, 'node_modules', 'electron');
const electronPackage = readJson(path.join(electronRoot, 'package.json'));
const version = electronPackage.version;

const platform = process.env.npm_config_platform || process.platform;
const arch = process.env.npm_config_arch || process.arch;
const platformPath = getPlatformPath(platform);
const distPath = path.join(electronRoot, 'dist');

if (isInstalled()) {
  console.log(`electron ${version} ready`);
  process.exit(0);
}

fs.rmSync(distPath, { force: true, recursive: true });
fs.rmSync(path.join(electronRoot, 'path.txt'), { force: true });

try {
  const zipPath = await downloadArtifact({
    artifactName: 'electron',
    arch,
    checksums: readJson(path.join(electronRoot, 'checksums.json')),
    force: true,
    platform,
    version,
  });
  extractElectronZip(zipPath, distPath);

  const typeDefinitions = path.join(distPath, 'electron.d.ts');
  if (fs.existsSync(typeDefinitions)) {
    fs.renameSync(typeDefinitions, path.join(electronRoot, 'electron.d.ts'));
  }

  fs.writeFileSync(path.join(electronRoot, 'path.txt'), platformPath);
  if (!isInstalled()) {
    throw new Error(`Electron ${version} did not install for ${platform}-${arch}`);
  }
  console.log(`electron ${version} installed for ${platform}-${arch}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

function isInstalled() {
  try {
    const installedVersion = fs.readFileSync(path.join(distPath, 'version'), 'utf8').replace(/^v/, '');
    const installedPath = fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8');
    const executablePath = path.join(distPath, platformPath);

    return installedVersion === version && installedPath === platformPath && fs.existsSync(executablePath);
  } catch {
    return false;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function extractElectronZip(zipPath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  if (process.platform === 'win32') {
    childProcess.execFileSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${escapePowerShellString(zipPath)}' -DestinationPath '${escapePowerShellString(targetDir)}' -Force`,
    ], { stdio: 'inherit' });
    return;
  }

  childProcess.execFileSync('unzip', ['-q', zipPath, '-d', targetDir], { stdio: 'inherit' });
}

function escapePowerShellString(value) {
  return value.replaceAll("'", "''");
}

function getPlatformPath(targetPlatform) {
  switch (targetPlatform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(`Electron builds are not available on ${os.platform()}`);
  }
}
