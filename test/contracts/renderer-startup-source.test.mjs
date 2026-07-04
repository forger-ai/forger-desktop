import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const readSource = async (relativePath) => await readFile(path.join(root, relativePath), 'utf8');

test('renderer startup hydrates provider auth independently from slower startup data', async () => {
  const controller = await readSource('src/renderer/app/RendererAppController.tsx');
  const loadDataStart = controller.indexOf('const loadData = () =>');
  const loadDataEnd = controller.indexOf('};\nloadData();', loadDataStart);
  const loadDataSource = controller.slice(loadDataStart, loadDataEnd);

  assert.match(loadDataSource, /settle\(desktopApi\.getCodexAuthStatus\(\), \(value\) => \{ setCodexAuthStatus\(value\);/);
  assert.match(loadDataSource, /settle\(desktopApi\.getClaudeAuthStatus\(\), \(value\) => \{ setClaudeAuthStatus\(value\);/);
  assert.match(loadDataSource, /settle\(desktopApi\.getAntigravityAuthStatus\(\), \(value\) => \{ setAntigravityAuthStatus\(value\);/);
  assert.match(loadDataSource, /setSelectedCodexModel\(value\.agentDefaults\.codex\.model\);/);
  assert.match(loadDataSource, /setSelectedClaudeModel\(value\.agentDefaults\.claude\.model\);/);
  assert.match(loadDataSource, /setSelectedAntigravityModel\(value\.agentDefaults\.antigravity\.model\);/);
  assert.equal(loadDataSource.includes('Promise.allSettled(['), false);
});
