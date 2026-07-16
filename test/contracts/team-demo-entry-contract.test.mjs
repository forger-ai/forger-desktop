import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Teams demo is an optional pinnable More module, not a default primary destination', () => {
  const sidebar = read('src/renderer/components/Sidebar.tsx');
  const more = read('src/renderer/views/MoreView.tsx');
  const renderer = read('src/renderer/app/RendererAppView.tsx');

  assert.match(sidebar, /PINNABLE_VIEWS[^\n]*'teams'/);
  assert.doesNotMatch(sidebar.match(/const defaultNav = \[[\s\S]*?\];/)?.[0] ?? '', /id: 'teams'/);
  assert.match(more, /teams/);
  assert.match(renderer, /currentView === 'teams'/);
  assert.match(renderer, /TeamDemoView/);
});

test('Personal Teams entry exposes only the demo request bridge', () => {
  const channels = read('src/shared/ipc.ts');
  const preload = read('src/preload/index.ts');
  const api = read('src/shared/types/desktop-api.ts');

  assert.match(channels, /requestTeamDemo/);
  assert.match(preload, /requestTeamDemo/);
  assert.match(api, /requestTeamDemo/);
  assert.doesNotMatch(channels, /teamsContext|selectTeam|teamWorkspace/);
});
