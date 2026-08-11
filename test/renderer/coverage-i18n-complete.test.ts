import { describe, expect, it } from 'vitest';
import { en } from '@renderer/i18n/en';
import { es } from '@renderer/i18n/es';
import { defaultLocale, getDictionary, type Locale } from '@renderer/i18n';

type TranslationFunction = (...args: any[]) => unknown;

const collectFunctions = (value: unknown, prefix = ''): Array<{ path: string; fn: TranslationFunction }> => {
  if (typeof value === 'function') {
    return [{ path: prefix, fn: value as TranslationFunction }];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => collectFunctions(child, prefix ? `${prefix}.${key}` : key));
};

const collectShape = (value: unknown, prefix = ''): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) => collectShape(child, prefix ? `${prefix}.${key}` : key));
};

const argumentSets: any[][] = [
  [],
  [undefined, undefined, undefined, undefined],
  ['', '', '', ''],
  ['Example', 'Owner', 'quarantine-1', '/safe/staged'],
  ['pro', 'Default', 'extra', 'value'],
  ['demo', '', '', ''],
  ['free', 'Owner', 'extra', 'value'],
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [2, 1, 3, 4],
  [59, 100, 3, 4],
  [60, 100, 3, 4],
  [61, 100, 3, 4],
  [1439, 100, 3, 4],
  [1440, 100, 3, 4],
  [{ background: '#ffffff', accent: '#ff0000', secondary: '#00ff00' }, 'Description', 'Purpose', 'Look'],
];

const exerciseDictionary = (dictionary: unknown) => {
  const functions = collectFunctions(dictionary);
  expect(functions.length).toBeGreaterThan(100);
  for (const { path, fn } of functions) {
    const successfulResults: unknown[] = [];
    for (const args of argumentSets) {
      try {
        successfulResults.push(fn(...args));
      } catch {
        // Every translation has a different signature. Other compatible
        // argument sets below still exercise and validate this callable.
      }
    }
    expect(successfulResults.length, `${path} accepts at least one representative input`).toBeGreaterThan(0);
    const displayableResults = successfulResults.filter((result) => (
      typeof result === 'string' || Array.isArray(result) || (result !== null && typeof result === 'object')
    ));
    expect(displayableResults.length, `${path} returns displayable localized content`).toBeGreaterThan(0);
  }
};

describe('complete localization dictionaries', () => {
  it('keeps English and Spanish structurally equivalent', () => {
    expect(collectShape(es).sort()).toEqual(collectShape(en).sort());
  });

  it('exercises every English translation function and conditional wording', () => {
    exerciseDictionary(en);
  });

  it('exercises every Spanish translation function and conditional wording', () => {
    exerciseDictionary(es);
  });

  it('resolves the explicit and default locale through the public API', () => {
    expect(['en', 'es']).toContain(defaultLocale);
    expect(getDictionary()).toBe(defaultLocale === 'es' ? es : en);
    expect(getDictionary('en')).toBe(en);
    expect(getDictionary('es')).toBe(es);
    expect(getDictionary('unsupported' as Locale)).toBe(defaultLocale === 'es' ? es : en);
  });
});
