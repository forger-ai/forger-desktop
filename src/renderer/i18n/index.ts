import { en } from './en';
import { es } from './es';

export const dictionaries = {
  es,
  en,
};

export type Locale = keyof typeof dictionaries;
export type AppDictionary = typeof es;

export const defaultLocale: Locale = 'es';

export const getDictionary = (locale: Locale = defaultLocale): AppDictionary =>
  (dictionaries[locale] ?? dictionaries[defaultLocale]) as AppDictionary;
