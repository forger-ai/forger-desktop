import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapCatalogItem } = require('../../dist-electron/main/forger-backend/catalog-normalizers.js');

const mapCatalog = (entry) => mapCatalogItem(entry, true, {
  backendBaseUrl: 'https://platform.test',
  mapBackendCategory: () => 'productividad',
  toCatalogStatus: () => 'not_installed',
  getUserMessage: () => undefined,
});

test('catalog normalizer preserves manifest runtime declarations on agents and prompt templates', () => {
  const app = mapCatalog({
    slug: 'finance-os',
    name: 'Finance OS',
    category: 'finance',
    latest_version: {
      version: '1.0.0',
      agents: [
        {
          id: 'advisor',
          title: 'Advisor',
          prompts: { initial: { body: 'Review {{thing}}.', variables: { thing: { type: 'text' } } } },
          provider: 'claude',
          model: 'sonnet',
          effort: 'max',
        },
      ],
      prompt_templates: [
        {
          id: 'summary',
          title: 'Summary',
          prompt: 'Summarize {{file}}.',
          runtime: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
        },
      ],
    },
  });

  assert.deepEqual(app.agents[0].runtime, { provider: 'claude', model: 'sonnet', effort: 'max' });
  assert.deepEqual(app.promptTemplates[0].runtime, { provider: 'codex', model: 'gpt-5.5', effort: 'high' });
});
