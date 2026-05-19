import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMacTerminalLoginScript } = require('../../dist-electron/main/auth-login-scripts.js');

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
