export function money(minor: number | null | undefined, currency = 'EUR', locale = 'en') {
  if (minor == null) return '–';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
}

/** Timestamps are stored in UTC; shown in the viewer's own time zone */
export function dateTime(iso: string | Date | null | undefined, locale = 'en') {
  if (!iso) return '–';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

export function date(iso: string | Date | null | undefined, locale = 'en') {
  if (!iso) return '–';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

export function km(n: number, locale = 'en') {
  return `${new Intl.NumberFormat(locale).format(n)} km`;
}

export function shortId(id: string) {
  return id.slice(0, 8);
}
