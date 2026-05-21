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
          runtimeRecommendations: {
            codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
            claude: { model: 'sonnet', effort: 'high' },
          },
        },
      ],
      prompt_templates: [
        {
          id: 'summary',
          title: 'Summary',
          prompt: 'Summarize {{file}}.',
          runtime: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
          runtimeRecommendations: {
            codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
            claude: { model: 'sonnet', effort: 'medium' },
          },
        },
      ],
    },
  });

  assert.deepEqual(app.agents[0].runtime, { provider: 'claude', model: 'sonnet', effort: 'max' });
  assert.deepEqual(app.agents[0].runtimeRecommendations, {
    codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
    claude: { model: 'sonnet', effort: 'high' },
  });
  assert.deepEqual(app.promptTemplates[0].runtime, { provider: 'codex', model: 'gpt-5.5', effort: 'high' });
  assert.deepEqual(app.promptTemplates[0].runtimeRecommendations, {
    codex: { model: 'gpt-5.4', reasoningEffort: 'medium' },
    claude: { model: 'sonnet', effort: 'medium' },
  });
});

test('catalog normalizer drops malformed ratings, tools, prompt variables, and unsafe URLs', () => {
  const app = mapCatalog({
    slug: 'recipes',
    name: 'Recipes',
    category: 'recipes',
    icon_url: 'http://[bad-url]',
    average_rating: 'bad',
    ratings_count: '7',
    recent_ratings: [
      { id: 'bad', score: 5, comment: 'drop invalid id' },
      { id: '4', score: '4', user: { first_name: 'Ana', last_initial: 'P' } },
    ],
    current_user_rating: { id: 9, score: 'bad' },
    latest_version: {
      version: '2.0.0',
      changelog: { summary: 'Updated', changes: ['ok', 42] },
      tools: {
        required: [
          { toolId: 'gmail', actions: ['gmail.read', ''], reason: ' Read mail ' },
          { toolId: 'empty-actions', actions: [], reason: 'drop' },
          { toolId: 'missing-reason', actions: ['gmail.send'] },
        ],
        optional: 'bad',
      },
      agents: [
        {
          id: 'agent',
          title: 'Agent',
          prompts: {
            initial: {
              body: 'Hello',
              variables: {
                file: { type: 'path', required: true },
                'bad space': { type: 'text' },
                unsafe: { type: 'date' },
              },
            },
          },
          kind: 'not-real',
        },
        { id: 'missing-prompt', title: 'Drop' },
      ],
      promptTemplates: [
        { id: 'quick', title: 'Quick', prompt: 'Run', reasoningEffort: 'xhigh' },
        { id: 'empty', title: 'Drop', prompt: '' },
      ],
    },
  });

  assert.equal(app.iconUrl, undefined);
  assert.equal(app.averageRating, undefined);
  assert.equal(app.ratingsCount, 7);
  assert.deepEqual(app.recentRatings.map((rating) => [rating.id, rating.score]), [[4, 4]]);
  assert.equal(app.currentUserRating, undefined);
  assert.deepEqual(app.tools, {
    required: [{ toolId: 'gmail', actions: ['gmail.read'], reason: 'Read mail' }],
    optional: [],
  });
  assert.deepEqual(app.agents[0].prompts.initial.variables, { file: { type: 'path', required: true } });
  assert.equal(app.agents[0].kind, undefined);
  assert.deepEqual(app.promptTemplates.map((template) => [template.id, template.reasoningEffort]), [['quick', 'xhigh']]);
  assert.deepEqual(app.changelog, { version: '2.0.0', summary: 'Updated', changes: ['ok'] });
});
