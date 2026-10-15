'use client';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';

export interface Place {
  label: string;
  addressLine: string;
  postcode: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  source: string;
}

/** Address autocomplete. In development only sample business addresses exist (clearly labelled). */
export function AddressSearch({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: Place | null;
  onChange(p: Place | null): void;
  placeholder: string;
  id: string;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState(value?.label ?? '');
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setQ(value?.label ?? ''), [value]);

  const search = (text: string) => {
    setQ(text);
    onChange(null);
    clearTimeout(timer.current);
    if (text.trim().length < 2) return setResults([]);
    timer.current = setTimeout(async () => {
      try {
        const r = await api<Place[]>(`/api/geo/search?q=${encodeURIComponent(text)}`);
        setResults(r);
        setActive(0);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 200);
  };
  const pick = (p: Place) => {
    onChange(p);
    setQ(p.label);
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        id={id}
        className="input text-base"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        autoComplete="off"
        placeholder={placeholder}
        value={q}
        onChange={(e) => search(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || results.length === 0) return;
          if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (e.key === 'Enter') {
            e.preventDefault();
            pick(results[active]!);
          } else return;
          e.preventDefault();
        }}
      />
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute z-[1100] mt-1 max-h-72 w-full overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-card"
        >
          {results.length === 0 && (
            <li className="px-3 py-2 text-sm text-ink-soft">{t('book.noAddress')}</li>
          )}
          {results.map((r, i) => (
            <li
              key={r.label}
              role="option"
              aria-selected={i === active}
              onMouseDown={() => pick(r)}
              className={`cursor-pointer px-3 py-2 text-sm ${i === active ? 'bg-brand-soft' : ''}`}
            >
              {r.label}
              {r.source === 'dev_sample' && (
                <span className="ml-2 text-xs text-amber-700">{t('book.sampleAddress')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
