import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'release');

const artifactNames = {
  mac: 'forger-desktop-macos-arm64.dmg',
  win: 'forger-desktop-windows-x64.exe',
};

const parseArgs = () => {
  const options = {
    platform: 'current',
    skipBuild: false,
    skipNotarize: false,
    waitNotarize: false,
    allowDirty: false,
    tag: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--skip-notarize') {
      options.skipNotarize = true;
    } else if (arg === '--wait-notarize') {
      options.waitNotarize = true;
    } else if (arg === '--allow-dirty') {
      options.allowDirty = true;
    } else if (arg.startsWith('--platform=')) {
      options.platform = arg.slice('--platform='.length);
    } else if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });

  child.on('error', reject);
  child.on('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
  });
});

const capture = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.on('error', reject);
  child.on('exit', (code) => {
    if (code === 0) {
      resolve(stdout.trim());
      return;
    }

    reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}\n${stderr.trim()}`));
  });
});

const exists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const getCurrentPlatform = () => {
  if (process.platform === 'darwin') {
    return 'mac';
  }

  if (process.platform === 'win32') {
    return 'win';
  }

  throw new Error(`Unsupported local release platform: ${process.platform}`);
};

const getPlatforms = (platform) => {
  if (platform === 'current') {
    return [getCurrentPlatform()];
  }

  if (platform === 'all') {
    return ['mac', 'win'];
  }

  if (platform === 'mac' || platform === 'win') {
    return [platform];
  }

  throw new Error(`Unsupported --platform value: ${platform}`);
};

const ensureCleanTree = async (allowDirty) => {
  if (allowDirty) {
    return;
  }

  const status = await capture('git', ['status', '--short']);
  if (status) {
    throw new Error('Working tree is dirty. Commit changes first, or pass --allow-dirty for a local test release.');
  }
};

const ensureTag = async (tag) => {
  let localTagExists = true;

  try {
    await capture('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
  } catch {
    localTagExists = false;
  }

  if (!localTagExists) {
    await run('git', ['tag', tag]);
  }

  await run('git', ['push', 'origin', tag]);
};

const resolveMacSigningIdentity = async () => {
  if (process.env.CSC_NAME) {
    return process.env.CSC_NAME.startsWith('Developer ID Application:')
      ? process.env.CSC_NAME
      : `Developer ID Application: ${process.env.CSC_NAME}`;
  }

  const identities = await capture('security', ['find-identity', '-v', '-p', 'codesigning']);
  const line = identities
    .split('\n')
    .find((entry) => entry.includes('Developer ID Application:'));

  const match = /"([^"]+)"/.exec(line ?? '');
  if (!match) {
    throw new Error('Developer ID Application signing identity not found. Set CSC_NAME or install the certificate in Keychain.');
  }

  return match[1];
};

const prepareMacSigningKeychain = async () => {
  if (!process.env.CSC_LINK) {
    return async () => {};
  }

  if (!process.env.CSC_KEY_PASSWORD) {
    throw new Error('CSC_KEY_PASSWORD is required when CSC_LINK is set.');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-signing-'));
  const certPath = path.join(tempDir, 'developer-id.p12');
  const keychainPath = path.join(tempDir, 'forger-signing.keychain-db');
  const keychainPassword = randomBytes(24).toString('hex');
  const previousKeychains = (await capture('security', ['list-keychains', '-d', 'user']))
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  if (await exists(process.env.CSC_LINK)) {
    await fs.copyFile(process.env.CSC_LINK, certPath);
  } else {
    await fs.writeFile(certPath, Buffer.from(process.env.CSC_LINK, 'base64'));
  }

  await run('security', ['create-keychain', '-p', keychainPassword, keychainPath]);
  await run('security', ['set-keychain-settings', '-lut', '21600', keychainPath]);
  await run('security', ['unlock-keychain', '-p', keychainPassword, keychainPath]);
  await run('security', [
    'import',
    certPath,
    '-k',
    keychainPath,
    '-P',
    process.env.CSC_KEY_PASSWORD,
    '-T',
    '/usr/bin/codesign',
  ]);
  await run('security', ['list-keychains', '-d', 'user', '-s', keychainPath, ...previousKeychains]);
  await run('security', [
    'set-key-partition-list',
    '-S',
    'apple-tool:,apple:,codesign:',
    '-s',
    '-k',
    keychainPassword,
    keychainPath,
  ]);

  return async () => {
    if (previousKeychains.length > 0) {
      await run('security', ['list-keychains', '-d', 'user', '-s', ...previousKeychains]);
    }

    await run('security', ['delete-keychain', keychainPath]);
    await fs.rm(tempDir, { recursive: true, force: true });
  };
};

const signMacRuntimeArchives = async () => {
  const identity = await resolveMacSigningIdentity();
  const runtimeRoot = path.join(rootDir, 'resources', 'runtimes');
  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-runtime-backups-'));
  const backups = [];

  if (!(await exists(runtimeRoot))) {
    await fs.rm(backupRoot, { recursive: true, force: true });
    return async () => {};
  }

  const archives = (await capture('find', [
    runtimeRoot,
    '-type',
    'f',
    '(',
    '-name',
    '*darwin*.tar.gz',
    '-o',
    '-name',
    '*apple-darwin*.tar.gz',
    ')',
  ])).split('\n').filter(Boolean);

  const restoreBackups = async () => {
    for (const [backupPath, originalPath] of backups.reverse()) {
      await fs.copyFile(backupPath, originalPath);
      await fs.rm(backupPath, { force: true });
    }

    await fs.rm(backupRoot, { recursive: true, force: true });
  };

  try {
    for (const archive of archives) {
      const backupName = Buffer.from(archive).toString('base64url');
      const archiveBackup = path.join(backupRoot, `${backupName}.tar.gz`);
      const checksumPath = `${archive}.sha256`;
      const checksumBackup = path.join(backupRoot, `${backupName}.tar.gz.sha256`);

      await fs.copyFile(archive, archiveBackup);
      backups.push([archiveBackup, archive]);

      if (await exists(checksumPath)) {
        await fs.copyFile(checksumPath, checksumBackup);
        backups.push([checksumBackup, checksumPath]);
      }

      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-runtime-signing-'));
      await run('tar', ['-xzf', archive, '-C', workDir]);

      const files = (await capture('find', [workDir, '-type', 'f'])).split('\n').filter(Boolean);
      for (const filePath of files) {
        const description = await capture('file', [filePath]);
        if (!description.includes('Mach-O')) {
          continue;
        }

        await run('codesign', [
          '--force',
          '--timestamp',
          '--options',
          'runtime',
          '--sign',
          identity,
          filePath,
        ]);
      }

      await run('tar', ['-czf', archive, '-C', workDir, '.']);
      await writeChecksum(archive);
      await fs.rm(workDir, { recursive: true, force: true });
    }
  } catch (error) {
    await restoreBackups();
    throw error;
  }

  return restoreBackups;
};

const writeChecksum = async (artifactPath) => {
  const buffer = await fs.readFile(artifactPath);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const checksumPath = `${artifactPath}.sha256`;
  await fs.writeFile(checksumPath, `${checksum}  ${path.basename(artifactPath)}\n`);
  return checksumPath;
};

const signMacDmg = async (artifactPath) => {
  const identity = await resolveMacSigningIdentity();
  await run('codesign', [
    '--force',
    '--timestamp',
    '--sign',
    identity,
    artifactPath,
  ]);
};

const resolveAppleApiKey = async () => {
  if (process.env.APPLE_API_KEY) {
    return process.env.APPLE_API_KEY;
  }

  if (!process.env.APPLE_API_KEY_BASE64) {
    return null;
  }

  const keyPath = path.join(
    process.env.TMPDIR ?? '/tmp',
    `AuthKey_${process.env.APPLE_API_KEY_ID ?? 'forger'}.p8`,
  );
  await fs.writeFile(keyPath, Buffer.from(process.env.APPLE_API_KEY_BASE64, 'base64'));
  await fs.chmod(keyPath, 0o600);
  return keyPath;
};

const notarizeMacArtifact = async (artifactPath, waitForResult) => {
  const appleApiKey = await resolveAppleApiKey();
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE ?? 'forger-notary';
  const missing = [];

  if (!appleApiKey && !keychainProfile) {
    missing.push('APPLE_API_KEY, APPLE_API_KEY_BASE64, or APPLE_KEYCHAIN_PROFILE');
  }

  if (appleApiKey && !process.env.APPLE_API_KEY_ID) {
    missing.push('APPLE_API_KEY_ID');
  }

  if (missing.length > 0) {
    throw new Error(`Missing notarization env vars: ${missing.join(', ')}`);
  }

  console.log(`Submitting ${path.basename(artifactPath)} to Apple notarization${waitForResult ? '' : ' without waiting'}...`);
  const submitArgs = [
    'notarytool',
    'submit',
    artifactPath,
    '--output-format',
    'json',
  ];

  if (appleApiKey) {
    submitArgs.push('--key', appleApiKey, '--key-id', process.env.APPLE_API_KEY_ID);
    if (process.env.APPLE_API_ISSUER) {
      submitArgs.push('--issuer', process.env.APPLE_API_ISSUER);
    }
  } else {
    submitArgs.push('--keychain-profile', keychainProfile);
  }

  if (waitForResult) {
    submitArgs.push('--wait', '--timeout', '30m');
  }

  const submitResult = await capture('xcrun', submitArgs);

  const parsedResult = JSON.parse(submitResult);
  const submissionId = parsedResult.id;
  const status = parsedResult.status;
  const submissionPath = path.join(releaseDir, 'notarization-submission.json');
  await fs.writeFile(submissionPath, `${JSON.stringify(parsedResult, null, 2)}\n`);
  console.log(`Apple notarization submission: ${status}${submissionId ? ` (${submissionId})` : ''}`);

  if (!waitForResult) {
    console.log(`Submission metadata written to ${submissionPath}`);
    return;
  }

  if (status !== 'Accepted') {
    if (submissionId) {
      const logPath = path.join(releaseDir, 'notarization-log.json');
      const logArgs = [
        'notarytool',
        'log',
        submissionId,
      ];
      if (appleApiKey) {
        logArgs.push('--key', appleApiKey, '--key-id', process.env.APPLE_API_KEY_ID);
        if (process.env.APPLE_API_ISSUER) {
          logArgs.push('--issuer', process.env.APPLE_API_ISSUER);
        }
      } else {
        logArgs.push('--keychain-profile', keychainProfile);
      }
      const logOutput = await capture('xcrun', logArgs);
      await fs.writeFile(logPath, logOutput);
      console.error(`Apple notarization log written to ${logPath}`);
    }

    throw new Error(`Apple notarization failed with status: ${status}`);
  }

  await run('xcrun', ['stapler', 'staple', artifactPath]);
};

const buildPlatform = async (platform) => {
  if (platform === 'mac') {
    await run('npm', ['run', 'dist:mac']);
    return;
  }

  if (platform === 'win') {
    await run('npm', ['run', 'dist:win']);
    return;
  }

  throw new Error(`Unsupported platform: ${platform}`);
};

const ensureRelease = async (tag, version) => {
  try {
    await capture('gh', ['release', 'view', tag]);
  } catch {
    await run('gh', [
      'release',
      'create',
      tag,
      '--title',
      `Forger Desktop v${version}`,
      '--notes',
      `Forger Desktop v${version}`,
    ]);
  }
};

const uploadArtifacts = async (tag, files) => {
  await run('gh', ['release', 'upload', tag, ...files, '--clobber']);
  await run('gh', ['release', 'edit', tag, '--latest']);
};

const main = async () => {
  const options = parseArgs();
  const pkg = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const tag = options.tag ?? `forger-desktop/v${pkg.version}`;
  const match = /^forger-desktop\/v(.+)$/.exec(tag);

  if (!match) {
    throw new Error(`Release tag must match forger-desktop/vX.Y.Z. Received: ${tag}`);
  }

  if (match[1] !== pkg.version) {
    throw new Error(`Tag version ${match[1]} does not match package.json version ${pkg.version}.`);
  }

  const platforms = getPlatforms(options.platform);
  await ensureCleanTree(options.allowDirty);

  const cleanupMacSigningKeychain = platforms.includes('mac')
    ? await prepareMacSigningKeychain()
    : async () => {};

  try {
    if (!options.skipBuild) {
      const restoreMacRuntimeArchives = platforms.includes('mac')
        ? await signMacRuntimeArchives()
        : async () => {};
      try {
        for (const platform of platforms) {
          await buildPlatform(platform);
        }
      } finally {
        await restoreMacRuntimeArchives();
      }
    }

    const uploadFiles = [];

    for (const platform of platforms) {
      const artifactPath = path.join(releaseDir, artifactNames[platform]);

      if (!(await exists(artifactPath))) {
        throw new Error(`Expected artifact does not exist: ${artifactPath}`);
      }

      if (platform === 'mac') {
        await signMacDmg(artifactPath);
        if (!options.skipNotarize) {
          await notarizeMacArtifact(artifactPath, options.waitNotarize);
        }
      }

      const checksumPath = await writeChecksum(artifactPath);
      uploadFiles.push(artifactPath, checksumPath);
    }

    await ensureTag(tag);
    await ensureRelease(tag, pkg.version);
    await uploadArtifacts(tag, uploadFiles);

    console.log(`Published ${tag} as latest with ${uploadFiles.length / 2} artifact set(s).`);
  } finally {
    await cleanupMacSigningKeychain();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
