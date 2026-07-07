import { en, type Dictionary } from './en';
import { de } from './de';
import type { Locale } from './config';

export * from './config';
export type { Dictionary };

export const DICTIONARIES: Record<Locale, Dictionary> = { en, de };

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}
