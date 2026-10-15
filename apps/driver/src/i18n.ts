/** Driver app texts. English is the reference; every language must have every key (checked by TypeScript). */
export const en = {
  'app.title': 'Driver',
  'safety.title': 'Stop the vehicle first',
  'safety.text': 'For your safety the app only works when the vehicle is standing still.',
  'login.title': 'Log in',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.submit': 'Log in',
  'login.failed': 'Email or password is wrong',
  'login.offline': 'No connection. Try again when you have signal.',
  logout: 'Log out',
  'jobs.title': 'My jobs',
  'jobs.empty': 'No jobs assigned to you',
  'jobs.active': 'Active',
  'jobs.finished': 'Finished',
  'jobs.refresh': 'Refresh',
  'outbox.waiting': '{n} step(s) waiting for signal',
  'outbox.failed': 'Not accepted: {error}',
  'outbox.dismiss': 'Remove',
  'job.pickup': 'Pickup',
  'job.delivery': 'Delivery',
  'job.window': '{from} – {to}',
  'job.navigate': 'Navigate',
  'job.call': 'Call',
  'job.cargo': 'Goods',
  'job.units': '{n} units · {kg} kg',
  'job.forklift': 'Forklift on site',
  'job.dock': 'Loading dock',
  'job.customs': 'Customs: check the border documents',
  'job.border': 'Border documents',
  'job.back': 'Back',
  'step.arrivedPickup': 'I am at the pickup',
  'step.loaded': 'Goods loaded',
  'step.departed': 'Leaving the pickup',
  'step.border': 'Border crossed',
  'step.delay': 'Report a delay',
  'step.arrivedDelivery': 'I am at the delivery',
  'step.delivered': 'Goods delivered',
  'step.done': 'Done',
  'form.count': 'Units counted',
  'form.expected': 'Expected: {n}',
  'form.difference': 'What is different?',
  'form.photos': 'Photos',
  'form.addPhoto': 'Take photo',
  'form.recipient': 'Name of the recipient',
  'form.signature': 'Signature of the recipient',
  'form.clear': 'Clear',
  'form.damage': 'Goods damaged',
  'form.damageNote': 'Describe the damage',
  'form.delayMinutes': 'Delay in minutes',
  'form.reason': 'Reason',
  'form.country': 'Country entered (e.g. NO)',
  'form.save': 'Confirm',
  'form.cancel': 'Cancel',
  'form.needCount': 'Enter the count',
  'form.needDifference': 'The count differs: describe the difference',
  'form.needRecipient': 'Enter the recipient’s name',
  'form.needEvidence': 'Add the signature or a photo',
  'form.needDamageNote': 'Describe the damage',
  'saved.offline': 'Saved. It will be sent when you have signal.',
  'tracking.on': 'Your position is shared with the customer while this job is active',
  'tracking.denied': 'Location is off: the customer cannot see progress',
  'status.booked': 'To do',
  'status.in_transit': 'On the way',
  'status.delivered': 'Delivered',
  'status.completed': 'Completed',
  'status.cancelled': 'Cancelled',
  'status.disputed': 'Disputed',
  'border.title': 'Border readiness',
  'border.none': 'No customs needed for this trip',
  'border.missing': 'Not ready: do not go to the border yet',
  'border.ready': 'Ready for the border',
  'border.references': 'References to show',
  'border.contact': 'Customs contact',
};

export type Key = keyof typeof en;
export type Dict = Record<Key, string>;

import { others } from './i18n.others';

const DICTS: Record<string, Dict> = { en, ...others };

export function pickLanguage(): string {
  const loc = (Intl.DateTimeFormat().resolvedOptions().locale || 'en').slice(0, 2);
  return loc in DICTS ? loc : 'en';
}

let lang = pickLanguage();
export function setLanguage(l: string) {
  if (l in DICTS) lang = l;
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  let s = DICTS[lang]?.[key] ?? en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function locale() {
  return lang;
}
