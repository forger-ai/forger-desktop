import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const readSource = async (relativePath) => await readFile(path.join(root, relativePath), 'utf8');

test('Desktop update modal is localized and renders accumulated version summaries', async () => {
  const viewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const esSource = await readSource('src/renderer/i18n/es.ts');
  const enSource = await readSource('src/renderer/i18n/en.ts');

  assert.match(viewSource, /desktopUpdateState\.pendingReleaseSummaries/);
  assert.match(viewSource, /ReactMarkdown/);
  assert.match(viewSource, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(viewSource, /desktopUpdateModalChangesHeading/);
  assert.match(viewSource, /`v\$\{release\.version\}`/);
  assert.match(viewSource, /content=\{release\.summary\}/);
  assert.match(esSource, /desktopUpdateModalTitle: '¡Hay una nueva versión de Forger!'/);
  assert.match(esSource, /desktopUpdateModalChangesHeading: 'CAMBIOS'/);
  assert.match(enSource, /desktopUpdateModalTitle: 'A new Forger version is available!'/);
  assert.match(enSource, /desktopUpdateModalChangesHeading: 'CHANGES'/);
});

test('Desktop pins stable Codex and Claude CLI package versions', async () => {
  const defaultsSource = await readSource('src/main/core/agent-runtime-defaults.ts');

  assert.match(defaultsSource, /CODEX_CLI_VERSION = '0\.142\.5'/);
  assert.match(defaultsSource, /CLAUDE_CODE_VERSION = '2\.1\.200'/);
});
