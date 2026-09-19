'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { catalogApi, localized, type Category, type Service } from '@/lib/catalog-api';
import { ApiError } from '@/lib/auth-api';

/**
 * Service catalogue.
 *
 * The tree (category -> subcategory -> service) comes straight from the
 * database, so admins can change the catalogue without a deploy. Selecting a
 * service leads to the dynamic request form built from its field definitions.
 */
export default function ServicesPage() {
  const { t, locale } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
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
    if (!term) return categories;
    return categories
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
  }, [categories, search]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">{t('catalog.title')}</h1>
        <p className="mt-1 text-sm opacity-70">{t('catalog.subtitle')}</p>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('catalog.searchServices')}
          className="mt-4 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
        />
      </header>

      {loading && <p className="opacity-60">{t('common.loading')}</p>}
      {error && <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!loading && !error && filtered.length === 0 && <p className="opacity-60">{t('catalog.noServices')}</p>}

      <div className="space-y-8">
        {filtered.map((cat) => (
          <section key={cat.id}>
            <h2 className="text-lg font-semibold">{localized(cat, locale)}</h2>
            <div className="mt-3 space-y-5">
              {cat.subcategories.map((sub) => (
                <div key={sub.id}>
                  <div className="mb-2 text-sm font-medium opacity-60">{localized(sub, locale)}</div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {sub.services.map((service) => (
                      <ServiceCard key={service.id} service={service} locale={locale} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function ServiceCard({ service, locale }: { service: Service; locale: string }) {
  const { t } = useI18n();
  return (
    <Link
      href={`/${locale}/requests/new?service=${service.slug}`}
      className="flex flex-col gap-2 rounded-xl border border-black/10 p-4 transition hover:border-slate-900 dark:border-white/15 dark:hover:border-white"
    >
      <div className="font-semibold">{localized(service, locale)}</div>
      <div className="flex flex-wrap gap-1 text-xs opacity-70">
        <span className="rounded-full bg-black/5 px-2 py-0.5 dark:bg-white/10">{service.pricing_model}</span>
        {service.requires_location && (
          <span className="rounded-full bg-black/5 px-2 py-0.5 dark:bg-white/10">{t('catalog.requiresLocation')}</span>
        )}
        {service.requires_destination && (
          <span className="rounded-full bg-black/5 px-2 py-0.5 dark:bg-white/10">{t('catalog.requiresDestination')}</span>
        )}
      </div>
      {(service.min_price_minor != null || service.max_price_minor != null) && (
        <div className="text-xs opacity-60">
          {service.min_price_minor != null && `${t('catalog.from')} ${(service.min_price_minor / 100).toFixed(0)} ${service.default_currency}`}
        </div>
      )}
    </Link>
  );
}
