import fs from 'node:fs';

const tagName = process.env.GITHUB_REF_NAME ?? process.argv[2] ?? '';
const match = /^forger-desktop\/v(.+)$/.exec(tagName);

if (!match) {
  throw new Error(`Release tag must match forger-desktop/vX.Y.Z. Received: ${tagName || '(empty)'}`);
}

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tagVersion = match[1];

if (pkg.version !== tagVersion) {
  throw new Error(`Tag version ${tagVersion} does not match package.json version ${pkg.version}.`);
}

console.log(`Release tag ${tagName} matches package.json version ${pkg.version}.`);

