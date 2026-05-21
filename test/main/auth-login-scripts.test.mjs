import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildMacTerminalLoginScript,
  buildMacTerminalScriptLaunchCommand,
  shellQuote,
} = require('../../dist-electron/main/auth-login-scripts.js');

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

test('macOS login script quotes env, PATH entries, and launch scripts safely', () => {
  const script = buildMacTerminalLoginScript({
    providerName: 'Codex CLI',
    logPath: "/tmp/forger login's.log",
    command: ["/opt/Codex CLI/codex's", 'login'],
    env: {
      CODEX_HOME: "/tmp/codex home's",
    },
    pathEntries: ['/opt/codex/bin', "/tmp/bin's"],
  });

  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(buildMacTerminalScriptLaunchCommand("/tmp/login script's.sh"), "/bin/bash '/tmp/login script'\\''s.sh'");
  assert.match(script, /export FORGER_LOGIN_LOG='\/tmp\/forger login'\\''s\.log'/);
  assert.match(script, /export CODEX_HOME='\/tmp\/codex home'\\''s'/);
  assert.match(script, /export PATH='\/opt\/codex\/bin:\/tmp\/bin'\\''s':"\$PATH"/);
  assert.match(script, /FORGER_CODEX_CLI_LOGIN_EXIT=\$\?/);
  assert.match(script, /'\/opt\/Codex CLI\/codex'\\''s' 'login'/);
});
