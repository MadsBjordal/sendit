import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { de } from './de';
import { pl } from './pl';
import { fr } from './fr';
import { es } from './es';
import { it as itMessages } from './it';
import { nl } from './nl';

const all = { de, pl, fr, es, it: itMessages, nl };
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  for (const [lang, dict] of Object.entries(all)) {
    it(`${lang} has every key, no extras, the same placeholders and no empty text`, () => {
      expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(en)) {
        const text = (dict as Record<string, string>)[k]!;
        expect(text.trim(), `${lang} ${k}`).not.toBe('');
        expect(placeholders(text), `${lang} ${k}`).toEqual(placeholders(v));
      }
    });
  }

  it('every literal key used in the pages exists', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith('.tsx')) files.push(join(dir, e.name));
      }
    };
    walk(join(__dirname, '..'));
    const missing = new Set<string>();
    for (const f of files)
      for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('([a-z][\w.]+)'/g))
        if (!(m[1]! in en)) missing.add(m[1]!);
    expect([...missing]).toEqual([]);
  });
});
