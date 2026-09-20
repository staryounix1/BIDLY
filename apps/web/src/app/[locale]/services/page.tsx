'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { catalogApi, localized, type Category, type Service } from '@/lib/catalog-api';
import { ApiError } from '@/lib/auth-api';
import { CategoryIcon, iconForSlug, type IconName } from '@/lib/icons';

/**
 * Service catalogue — the marketplace discovery surface.
 *
 * Layout follows what customers already know from global on-demand apps:
 * a searchable hero, a horizontally scrolling category rail for thumb reach,
 * then rich service cards with the price signal and instant-request affordance
 * visible without a tap. The category tree still comes from the database, so
 * admins keep changing the catalogue without a deploy.
 */

const BRAND_TINTS: Array<{ from: string; to: string; ring: string; text: string }> = [
  { from: 'from-indigo-500', to: 'to-violet-500', ring: 'ring-indigo-500/25', text: 'text-indigo-600' },
  { from: 'from-sky-500', to: 'to-blue-600', ring: 'ring-sky-500/25', text: 'text-sky-600' },
  { from: 'from-emerald-500', to: 'to-teal-600', ring: 'ring-emerald-500/25', text: 'text-emerald-600' },
  { from: 'from-amber-500', to: 'to-orange-600', ring: 'ring-amber-500/25', text: 'text-amber-600' },
  { from: 'from-rose-500', to: 'to-pink-600', ring: 'ring-rose-500/25', text: 'text-rose-600' },
  { from: 'from-fuchsia-500', to: 'to-purple-600', ring: 'ring-fuchsia-500/25', text: 'text-fuchsia-600' },
];

function tintFor(seed: string): (typeof BRAND_TINTS)[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return BRAND_TINTS[h % BRAND_TINTS.length]!;
}

/** Pricing models are data; this turns them into a customer-facing label. */
function PricingChip({ service }: { service: Service }) {
  const { t } = useI18n();
  const model = service.pricing_model;
  const isInstant = model === 'FIXED' || model === 'RANGE' || model === 'HOURLY';
  return (
    <span className={`chip ${isInstant ? 'chip-brand' : 'chip-neutral'}`}>
      <CategoryIcon name={isInstant ? 'bolt' : 'layers'} size={12} />
      {t(`catalog.pricing.${model}`)}
    </span>
  );
}

/** "from 100 – 2,000 MAD" / "Quote on inspection" / "Get offers". */
function PriceLine({ service }: { service: Service }) {
  const { t } = useI18n();
  const min = service.min_price_minor;
  const max = service.max_price_minor;
  const cur = service.default_currency;

  if (min == null && max == null) {
    return <span className="text-sm font-medium text-[rgb(var(--fg-muted))]">{t('catalog.priceOnRequest')}</span>;
  }
  if (min != null && max != null && max > min) {
    return (
      <span className="tnum text-sm">
        <span className="text-[rgb(var(--fg-subtle))]">{t('catalog.from')} </span>
        <span className="font-bold text-[rgb(var(--fg))]">{Math.round(min / 100).toLocaleString()}</span>
        <span className="text-[rgb(var(--fg-subtle))]"> – </span>
        <span className="font-bold text-[rgb(var(--fg))]">{Math.round(max / 100).toLocaleString()}</span>
        <span className="ms-1 text-xs font-semibold text-[rgb(var(--fg-muted))]">{cur}</span>
      </span>
    );
  }
  return (
    <span className="tnum text-sm">
      <span className="text-[rgb(var(--fg-subtle))]">{t('catalog.from')} </span>
      <span className="font-bold text-[rgb(var(--fg))]">{Math.round((min ?? max ?? 0) / 100).toLocaleString()}</span>
      <span className="ms-1 text-xs font-semibold text-[rgb(var(--fg-muted))]">{cur}</span>
    </span>
  );
}

/** One service row inside a subcategory group. */
function ServiceCard({ service, locale, index }: { service: Service; locale: string; index: number }) {
  const { t } = useI18n();
  const icon = iconForSlug(service.slug);
  const tint = tintFor(service.slug);

  return (
    <Link
      href={`/${locale}/requests/new?service=${service.slug}`}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
      className="card card-hover fade-rise group flex flex-col gap-3 p-4"
    >
      <div className="flex items-start gap-3">
        <span
          className={`icon-tile h-11 w-11 bg-gradient-to-br ${tint.from} ${tint.to} text-white shadow-sm`}
        >
          <CategoryIcon name={icon as IconName} size={21} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[0.9375rem] font-bold leading-snug">{localized(service, locale)}</h3>
          <p className="mt-0.5 truncate text-xs text-[rgb(var(--fg-subtle))]">{service.slug.replace(/-/g, ' ')}</p>
        </div>
        <span className="icon-tile h-8 w-8 bg-[rgb(var(--surface-3))] text-[rgb(var(--fg-subtle))] transition group-hover:bg-[rgb(var(--brand-500))] group-hover:text-white">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="rotate-180 rtl:rotate-0">
            <path d="M5 12h13M12 5l7 7-7 7" />
          </svg>
        </span>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <PricingChip service={service} />
        {service.requires_location && (
          <span className="chip chip-neutral">
            <CategoryIcon name="pin" size={12} />
            {t('catalog.requiresLocation')}
          </span>
        )}
        {service.duration_minutes != null && (
          <span className="chip chip-neutral">
            <CategoryIcon name="clock" size={12} />
            <span className="tnum">{service.duration_minutes}</span>
          </span>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-[rgb(var(--line))] pt-3">
        <PriceLine service={service} />
        <span className="text-xs font-bold text-[rgb(var(--brand-600))] opacity-0 transition group-hover:opacity-100 dark:text-[rgb(var(--brand-300))]">
          {t('catalog.requestNow')}
        </span>
      </div>
    </Link>
  );
}

/** Skeleton card shown while the catalogue loads. */
function CardSkeleton() {
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="skeleton h-11 w-11 rounded-xl" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-3.5 w-3/5" />
          <div className="skeleton h-2.5 w-2/5" />
        </div>
      </div>
      <div className="mt-3 flex gap-1.5">
        <div className="skeleton h-6 w-20 rounded-full" />
        <div className="skeleton h-6 w-24 rounded-full" />
      </div>
      <div className="mt-3 border-t border-[rgb(var(--line))] pt-3">
        <div className="skeleton h-3.5 w-24" />
      </div>
    </div>
  );
}

export default function ServicesPage() {
  const { t, locale } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [activeCat, setActiveCat] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await catalogApi.tree();
        if (!cancelled) setCategories(data.categories);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const inCat = (cat: Category) => activeCat === 'all' || cat.slug === activeCat;
    if (!term) return categories.filter(inCat);
    return categories
      .filter(inCat)
      .map((cat) => ({
        ...cat,
        subcategories: cat.subcategories
          .map((sub) => ({
            ...sub,
            services: sub.services.filter((s) =>
              [s.name_en, s.name_fr, s.name_ar, s.slug]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(term)),
            ),
          }))
          .filter((sub) => sub.services.length > 0),
      }))
      .filter((cat) => cat.subcategories.length > 0);
  }, [categories, search, activeCat]);

  const totalServices = useMemo(
    () => categories.reduce((n, c) => n + c.subcategories.reduce((m, s) => m + s.services.length, 0), 0),
    [categories],
  );

  const showNoResults = !loading && !error && filtered.length === 0;

  return (
    <main className="min-h-screen">
      {/* Hero: search-first, the way marketplace apps open. */}
      <section className="mesh relative overflow-hidden border-b border-[rgb(var(--line))]">
        <div className="container-page relative py-10 sm:py-14">
          <div className="max-w-2xl">
            <span className="chip chip-brand mb-4">
              <CategoryIcon name="spark" size={13} />
              {t('catalog.badge')}
            </span>
            <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl">
              {t('catalog.heroTitle')}{' '}
              <span className="brand-text">{t('catalog.heroHighlight')}</span>
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-[rgb(var(--fg-muted))] sm:text-base">
              {t('catalog.heroSubtitle')}
            </p>
          </div>

          <div className="mt-7 flex max-w-2xl items-center gap-2">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute inset-y-0 start-3.5 grid place-items-center text-[rgb(var(--fg-subtle))]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('catalog.searchServices')}
                aria-label={t('catalog.searchServices')}
                className="input h-12 ps-11 text-base shadow-sm"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label={t('common.close')}
                  className="absolute inset-y-0 end-3 grid place-items-center text-[rgb(var(--fg-subtle))] hover:text-[rgb(var(--fg))]"
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
            </div>
            <Link href={`/${locale}/requests/new`} className="btn btn-primary h-12 px-4 sm:px-5">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="hidden sm:inline">{t('nav.newRequest')}</span>
            </Link>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-[rgb(var(--fg-muted))]">
            <span className="inline-flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {t('catalog.liveProviders')}
            </span>
            <span className="tnum">{totalServices} {t('catalog.serviceCount')}</span>
            <span>{t('catalog.categoriesCount', { count: categories.length })}</span>
          </div>
        </div>
      </section>

      {/* Category rail — thumb-reachable horizontal scroll on phones. */}
      <div className="sticky top-[57px] z-10 border-b border-[rgb(var(--line))] surface-blur">
        <div className="container-page">
          <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto py-3">
            <RailChip
              active={activeCat === 'all'}
              onClick={() => setActiveCat('all')}
              icon="layers"
              label={t('catalog.allCategories')}
            />
            {categories.map((cat) => (
              <RailChip
                key={cat.id}
                active={activeCat === cat.slug}
                onClick={() => setActiveCat(cat.slug)}
                icon={iconForSlug(cat.slug, cat.icon)}
                label={localized(cat, locale)}
                gradient={tintFor(cat.slug)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="container-page py-8">
        {loading && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        )}

        {error && (
          <div className="card flex items-start gap-3 border-red-300/60 bg-red-50/70 p-4 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
            <CategoryIcon name="shield" size={18} />
            <div>
              <p className="font-semibold">{t('common.error')}</p>
              <p className="mt-0.5 opacity-80">{error}</p>
            </div>
          </div>
        )}

        {showNoResults && (
          <div className="card mx-auto max-w-md px-6 py-12 text-center">
            <span className="icon-tile mx-auto h-14 w-14 bg-[rgb(var(--surface-3))] text-[rgb(var(--fg-subtle))]">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <p className="mt-4 font-bold">{t('catalog.noServices')}</p>
            <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('catalog.noServicesHint')}</p>
            <button type="button" onClick={() => { setSearch(''); setActiveCat('all'); }} className="btn btn-secondary mt-5">
              {t('catalog.clearFilters')}
            </button>
          </div>
        )}

        <div className="space-y-10">
          {filtered.map((cat, ci) => {
            const tint = tintFor(cat.slug);
            const count = cat.subcategories.reduce((n, s) => n + s.services.length, 0);
            return (
              <section key={cat.id} style={{ animationDelay: `${ci * 60}ms` }} className="fade-rise">
                <div className="mb-4 flex items-center gap-3">
                  <span className={`icon-tile h-10 w-10 bg-gradient-to-br ${tint.from} ${tint.to} text-white shadow-sm`}>
                    <CategoryIcon name={iconForSlug(cat.slug, cat.icon)} size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-bold leading-tight">{localized(cat, locale)}</h2>
                    <p className="text-xs text-[rgb(var(--fg-subtle))]">
                      <span className="tnum">{count}</span> {t('catalog.serviceCount')}
                    </p>
                  </div>
                  <span className="h-px flex-1 bg-[rgb(var(--line))]" />
                </div>

                <div className="space-y-6">
                  {cat.subcategories.map((sub) => (
                    <div key={sub.id}>
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="text-[0.8125rem] font-semibold text-[rgb(var(--fg-muted))]">
                          {localized(sub, locale)}
                        </span>
                        <span className="tnum chip chip-neutral !py-0 !text-[0.6875rem]">
                          {sub.services.length}
                        </span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {sub.services.map((service, si) => (
                          <ServiceCard key={service.id} service={service} locale={locale} index={si} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}

function RailChip({
  active,
  onClick,
  icon,
  label,
  gradient,
}: {
  active: boolean;
  onClick: () => void;
  icon: IconName | string;
  label: string;
  gradient?: { from: string; to: string };
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex flex-none items-center gap-2 rounded-full border px-3.5 py-2 text-[0.8125rem] font-semibold transition ${
        active
          ? 'border-transparent bg-[rgb(var(--fg))] text-[rgb(var(--surface))] shadow-sm'
          : 'border-[rgb(var(--line))] bg-[rgb(var(--surface))] text-[rgb(var(--fg-muted))] hover:border-[rgb(var(--line-strong))] hover:text-[rgb(var(--fg))]'
      }`}
    >
      <span
        className={`grid h-6 w-6 place-items-center rounded-full ${
          active
            ? 'bg-white/15 text-white'
            : gradient
              ? `bg-gradient-to-br ${gradient.from} ${gradient.to} text-white`
              : 'bg-[rgb(var(--surface-3))] text-[rgb(var(--fg-muted))]'
        }`}
      >
        <CategoryIcon name={icon as IconName} size={14} />
      </span>
      {label}
    </button>
  );
}
