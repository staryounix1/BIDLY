'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { catalogApi, localized, type Category, type Service } from '@/lib/catalog-api';
import { ApiError } from '@/lib/auth-api';
import { CategoryIcon, iconForSlug } from '@/lib/icons';
import { Price, SectionTitle, Spinner } from '@/lib/ui';

/**
 * Choose a service — the customer's front door.
 *
 * Laid out like the category pickers people already use: white cards, a line
 * icon, the service name, and how many Khdemli craftsmen are reachable right
 * now. That count comes from the database (available providers with the service
 * active), so the number is honest about live supply instead of decorative.
 *
 * The catalogue itself is data — an admin adds a service and it appears here
 * without a deploy — so nothing below hardcodes a trade.
 */

interface ServiceRow {
  service: Service;
  subcategory: string;
  category: Category;
}

function formatCount(n: number): string {
  return n.toLocaleString('ar-MA');
}

/** One white card in the list. */
function ServiceCard({
  row,
  count,
  href,
  index,
}: {
  row: ServiceRow;
  count: number;
  href: string;
  index: number;
}) {
  const { t, locale } = useI18n();
  const icon = iconForSlug(row.service.slug, row.category.icon);
  const name = localized(row.service, locale);

  return (
    <Link
      href={href}
      className="card card-tap slide-in flex items-center gap-3.5 p-3.5"
      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
    >
      <span className="icon-tile h-14 w-14">
        <CategoryIcon name={icon} size={26} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-bold">{name}</span>
        <span className="mt-0.5 block truncate text-xs text-[rgb(var(--fg-muted))]">
          {row.subcategory}
        </span>
        <span className="mt-1 flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-xs font-bold text-[rgb(var(--brand-700))]">
            <CategoryIcon name="user" size={13} />
            {count > 0
              ? t('catalog.providersAvailable', { count: formatCount(count) })
              : t('catalog.noProvidersYet')}
          </span>
          {row.service.min_price_minor != null && (
            <span className="text-xs text-[rgb(var(--fg-subtle))]">
              · <Price minor={row.service.min_price_minor} currency={row.service.default_currency} size="sm" />
            </span>
          )}
        </span>
      </span>

      <CategoryIcon
        name="chevron"
        size={20}
        className="flex-none text-[rgb(var(--fg-subtle))] rtl:rotate-180"
      />
    </Link>
  );
}

export default function ServicesPage() {
  const { t, locale } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [counts, setCounts] = useState<{ byCategory: Record<string, number>; byService: Record<string, number> }>({
    byCategory: {},
    byService: {},
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  // The home screen's search box lands here with `?q=`, so the term the
  // customer already typed must survive the navigation instead of showing a
  // full catalogue and making them type it again. Read from `location` rather
  // than `useSearchParams()` so the route keeps prerendering (the hook forces
  // a Suspense boundary, and this page is static).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) setQuery(q);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tree, providerCounts] = await Promise.all([
          catalogApi.tree(),
          // Counts are decoration: never let a slow or missing count endpoint
          // hold up the catalogue the customer came for.
          catalogApi.providerCounts().catch(() => ({ byCategory: {}, byService: {} })),
        ]);
        if (!alive) return;
        setCategories(tree.categories ?? []);
        setCounts(providerCounts);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : t('common.error'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [t]);

  /** Flatten to one row per service so the list matches how people think. */
  const rows = useMemo<ServiceRow[]>(() => {
    const out: ServiceRow[] = [];
    for (const category of categories) {
      for (const sub of category.subcategories ?? []) {
        for (const service of sub.services ?? []) {
          out.push({ service, subcategory: localized(sub, locale), category });
        }
      }
    }
    return out;
  }, [categories, locale]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (activeCategory && row.category.id !== activeCategory) return false;
      if (!q) return true;
      const hay = [
        localized(row.service, locale),
        localized(row.category, locale),
        row.subcategory,
        row.service.slug,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, activeCategory, locale]);

  if (loading) {
    return (
      <div className="app-shell container-page flex items-center justify-center py-24">
        <Spinner size={28} />
      </div>
    );
  }

  return (
    <div className="app-shell container-page py-5">
      {/* Hero */}
      <div className="mb-4">
        <h1 className="text-2xl font-black tracking-tight">{t('catalog.chooseService')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('catalog.chooseServiceHint')}</p>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <CategoryIcon
          name="search"
          size={19}
          className="pointer-events-none absolute inset-y-0 start-3.5 my-auto text-[rgb(var(--fg-subtle))]"
        />
        <input
          className="input ps-11"
          placeholder={t('catalog.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('catalog.searchPlaceholder')}
        />
      </div>

      {/* Category rail */}
      {categories.length > 0 && (
        <div className="no-scrollbar -mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1">
          <button
            type="button"
            onClick={() => setActiveCategory(null)}
            className={
              activeCategory === null
                ? 'chip chip-brand h-9 px-4 text-sm'
                : 'chip chip-neutral h-9 px-4 text-sm'
            }
          >
            {t('catalog.all')}
          </button>
          {categories.map((category) => {
            const active = activeCategory === category.id;
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => setActiveCategory(active ? null : category.id)}
                className={
                  active ? 'chip chip-brand h-9 px-4 text-sm' : 'chip chip-neutral h-9 px-4 text-sm'
                }
              >
                <CategoryIcon name={iconForSlug(category.slug, category.icon)} size={15} />
                {localized(category, locale)}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="card mb-4 border-[rgb(var(--danger)/0.35)] p-4 text-sm text-[rgb(var(--danger))]">
          {error}
        </div>
      )}

      {/* Services */}
      <SectionTitle>{t('catalog.availableServices')}</SectionTitle>

      {filtered.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
          <span className="icon-tile h-14 w-14">
            <CategoryIcon name="search" size={24} />
          </span>
          <p className="text-base font-bold">{t('catalog.noResults')}</p>
          <p className="text-sm text-[rgb(var(--fg-muted))]">{t('catalog.noResultsHint')}</p>
        </div>
      ) : (
        <div className="grid gap-2.5">
          {filtered.map((row, index) => (
            <ServiceCard
              key={row.service.id}
              row={row}
              index={index}
              count={counts.byService[row.service.id] ?? 0}
              href={`/${locale}/requests/new?service=${encodeURIComponent(row.service.slug)}`}
            />
          ))}
        </div>
      )}

      {/* Trust strip: safety + no-shows, the two things customers ask about. */}
      <div className="mt-6 grid grid-cols-2 gap-2.5">
        <div className="card flex items-center gap-2.5 p-3.5">
          <span className="icon-tile h-10 w-10">
            <CategoryIcon name="shield" size={19} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold">{t('catalog.trustVerified')}</span>
            <span className="block truncate text-xs text-[rgb(var(--fg-muted))]">
              {t('catalog.trustVerifiedHint')}
            </span>
          </span>
        </div>
        <div className="card flex items-center gap-2.5 p-3.5">
          <span className="icon-tile h-10 w-10">
            <CategoryIcon name="wallet" size={19} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold">{t('catalog.trustPrice')}</span>
            <span className="block truncate text-xs text-[rgb(var(--fg-muted))]">
              {t('catalog.trustPriceHint')}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
