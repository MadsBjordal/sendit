'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './en';
import { de } from './de';
import { pl } from './pl';
import { fr } from './fr';
import { es } from './es';
import { it } from './it';
import { nl } from './nl';

export const LOCALES = { en, de, pl, fr, es, it, nl } as const;
export type Locale = keyof typeof LOCALES;
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  pl: 'Polski',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  nl: 'Nederlands',
};

/** Replaces {name} placeholders. Missing translations fall back to English, never to a raw key. */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const dict = LOCALES[locale] as Partial<Record<MessageKey, string>>;
  let text = dict[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
}

interface I18n {
  locale: Locale;
  setLocale(l: Locale): void;
  t(key: MessageKey, vars?: Record<string, string | number>): string;
}

const Ctx = createContext<I18n>({
  locale: 'en',
  setLocale: () => {},
  t: (k, v) => translate('en', k, v),
});

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem('pf.locale') as Locale | null;
    if (saved && saved in LOCALES) return saved;
  } catch {
    /* private mode */
  }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2) as Locale;
  return nav in LOCALES ? nav : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  useEffect(() => setLocaleState(initialLocale()), []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem('pf.locale', l);
    } catch {
      /* ignore */
    }
  }, []);
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );
  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}

export type { MessageKey };
