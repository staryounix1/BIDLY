'use client';

import { useI18n } from './i18n-provider';

/**
 * A coloured pill for a request (or job) status. The colour encodes the stage
 * of the lifecycle; the label is translated. Unknown statuses fall back to a
 * neutral style rather than breaking the layout.
 */
const TONE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  PUBLISHED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200',
  MATCHING: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200',
  RECEIVING_OFFERS: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200',
  PROVIDER_SELECTED: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200',
  CONFIRMED: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-200',
  IN_PROGRESS: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200',
  COMPLETED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200',
  CANCELLED: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200',
  EXPIRED: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200',
  DISPUTED: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200',
  REFUNDED: 'bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-200',
  FAILED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200',
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const tone = TONE[status] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200';
  const label = t(`status.${status}`);
  // `t` returns the key itself when the status is unknown; fall back to raw.
  const text = label.startsWith('status.') ? status : label;
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{text}</span>
  );
}
