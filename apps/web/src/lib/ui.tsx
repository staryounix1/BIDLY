'use client';

import { StarIcon } from './icons';

/**
 * Small presentational pieces shared by every screen.
 *
 * These are deliberately dumb: no data fetching, no i18n lookups that need a
 * provider, no routing. Screens compose them, which is what keeps 19 pages
 * looking like one product instead of 19 designs.
 */

/* --- stars -------------------------------------------------------------- */

export function Stars({
  value,
  count,
  size = 15,
  showValue = true,
}: {
  value: number | null | undefined;
  count?: number | null;
  size?: number;
  showValue?: boolean;
}) {
  const rating = value ?? 0;

  if (!value) {
    return <span className="text-xs font-semibold text-[rgb(var(--fg-subtle))]">—</span>;
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex items-center gap-0.5 text-[rgb(var(--warn))]">
        {[0, 1, 2, 3, 4].map((i) => (
          <StarIcon key={i} size={size} filled={i < Math.round(rating)} />
        ))}
      </span>
      {showValue && (
        <span className="tnum text-xs font-bold text-[rgb(var(--fg))]">{rating.toFixed(1)}</span>
      )}
      {count != null && count > 0 && (
        <span className="tnum text-xs text-[rgb(var(--fg-subtle))]">({count})</span>
      )}
    </span>
  );
}

/* --- avatar ------------------------------------------------------------- */

export function Avatar({
  name,
  src,
  size = 44,
}: {
  name?: string | null;
  src?: string | null;
  size?: number;
}) {
  const initials = (name ?? '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? ''}
        width={size}
        height={size}
        className="flex-none rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className="grid flex-none place-items-center rounded-full bg-[rgb(var(--brand-500)/0.20)] font-bold text-[rgb(var(--brand-800))]"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

/* --- price -------------------------------------------------------------- */

/** Big, unmissable price. Used on offer cards and the request composer. */
export function Price({
  minor,
  currency,
  size = 'md',
}: {
  minor: number | null | undefined;
  currency?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const sizes = {
    sm: 'text-base',
    md: 'text-xl',
    lg: 'text-2xl',
    xl: 'text-3xl',
  } as const;

  if (minor == null) return null;
  const whole = Math.round(minor / 100);

  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`price ${sizes[size]} text-[rgb(var(--fg))]`}>
        {whole.toLocaleString()}
      </span>
      <span className="text-xs font-bold text-[rgb(var(--fg-muted))]">{currency ?? 'MAD'}</span>
    </span>
  );
}

/* --- price stepper (+ / -) ---------------------------------------------- */

/**
 * The offer composer. Large +/- targets and a numeric field, because setting
 * your own price is the whole point of the product and thumbs are imprecise.
 */
export function PriceStepper({
  value,
  onChange,
  step = 10,
  min = 0,
  max = 100000,
  currency = 'MAD',
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  currency?: string;
  label?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const set = (n: number) => onChange(clamp(n));

  return (
    <div>
      {label && <span className="label">{label}</span>}
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={() => set(value - step)}
          disabled={value <= min}
          aria-label="نقص"
          className="btn btn-secondary w-16 flex-none text-2xl"
        >
          −
        </button>

        <div className="card flex flex-1 items-center justify-center gap-2 px-3 py-2">
          <input
            type="number"
            inputMode="numeric"
            value={value}
            onChange={(e) => set(Number(e.target.value))}
            className="tnum w-full bg-transparent text-center text-3xl font-extrabold tracking-tight outline-none"
            aria-label={label}
          />
          <span className="flex-none text-sm font-bold text-[rgb(var(--fg-muted))]">{currency}</span>
        </div>

        <button
          type="button"
          onClick={() => set(value + step)}
          disabled={value >= max}
          aria-label="زيد"
          className="btn btn-primary w-16 flex-none text-2xl"
        >
          +
        </button>
      </div>
    </div>
  );
}

/* --- section heading ---------------------------------------------------- */

export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-extrabold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

/* --- empty / error ------------------------------------------------------ */

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
      {icon && <div className="icon-tile h-14 w-14">{icon}</div>}
      <p className="text-base font-bold">{title}</p>
      {hint && <p className="max-w-sm text-sm text-[rgb(var(--fg-muted))]">{hint}</p>}
      {action}
    </div>
  );
}

/* --- busy button -------------------------------------------------------- */

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}
