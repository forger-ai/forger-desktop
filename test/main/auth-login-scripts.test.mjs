import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildMacTerminalLoginScript,
  buildMacTerminalScriptLaunchCommand,
} = require('../../dist-electron/main/auth-login-scripts.js');

test('macOS Codex login script carries CODEX_HOME, PATH, and codex login command', () => {
  const script = buildMacTerminalLoginScript({
    providerName: 'Codex',
    logPath: '/Users/test/Library/Application Support/forger-desktop/logs/codex-login.log',
    command: [
      '/Users/test/Library/Application Support/forger-desktop/codex-cli/node_modules/.bin/codex',
      'login',
    ],
    env: {
      CODEX_HOME: '/Users/test/Library/Application Support/forger-desktop/codex-home',
    },
    pathEntries: [
      '/Users/test/Library/Application Support/forger-desktop/runtimes/node/bin',
      '/Users/test/Library/Application Support/forger-desktop/codex-cli/node_modules/.bin',
    ],
  });

  assert.match(script, /^#!\/bin\/bash/);
  assert.match(script, /export CODEX_HOME='/);
  assert.match(script, /codex-home'/);
  assert.match(script, /export PATH='/);
  assert.match(script, /runtimes\/node\/bin/);
  assert.match(script, /node_modules\/\.bin/);
  assert.match(script, /'\/Users\/test\/Library\/Application Support\/forger-desktop\/codex-cli\/node_modules\/\.bin\/codex' 'login'/);
  assert.doesNotMatch(script, /export CODEX_HOME=.*; .*codex.* login/);
});

test('macOS Claude login script uses script body instead of inline Terminal command', () => {
  const script = buildMacTerminalLoginScript({
    providerName: 'Claude Code',
    logPath: '/tmp/claude-login.log',
    command: ['/opt/claude/bin/claude', 'auth', 'login'],
  });

  assert.match(script, /'\/opt\/claude\/bin\/claude' 'auth' 'login'/);
  assert.match(script, /Claude Code login finished/);
  assert.doesNotMatch(script, /do script/);
});

test('macOS Terminal launch command invokes the generated script with an absolute bash path', () => {
  const command = buildMacTerminalScriptLaunchCommand(
    '/Users/test/Library/Application Support/forger-desktop/tmp/codex-login.command',
  );

  assert.equal(
    command,
    "/bin/bash '/Users/test/Library/Application Support/forger-desktop/tmp/codex-login.command'",
  );
  assert.doesNotMatch(command, /^Users\//);
});
