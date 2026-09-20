'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { useAuth } from '@/lib/auth-provider';
import { catalogApi, localized, type Category, type Service } from '@/lib/catalog-api';
import { CategoryIcon, iconForSlug, KhdemliMark } from '@/lib/icons';

/**
 * Khdemli home.
 *
 * One promise, one action, then proof that real craftsmen are on the platform:
 * the category tiles are the database's own categories with live availability
 * counts, so the first screen a customer sees is never a mockup.
 */
export default function HomePage() {
  const { t, locale } = useI18n();
  const { user, ready } = useAuth();

  const [categories, setCategories] = useState<Category[]>([]);
  const [popular, setPopular] = useState<Service[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tree, providerCounts] = await Promise.all([
          catalogApi.tree(),
          catalogApi.providerCounts(),
        ]);
        if (!alive) return;
        setCategories(tree.categories ?? []);
        setCounts(providerCounts.byCategory);
        setPopular(
          (tree.categories ?? [])
            .flatMap((c) => c.subcategories.flatMap((s) => s.services))
            .slice(0, 8),
        );
      } catch {
        // A failed catalogue must not blank the landing page.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="app-shell container-page py-5">
      {/* Hero */}
      <section className="mb-5">
        <div className="flex items-center gap-3">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[rgb(var(--brand-500)/0.16)]">
            <KhdemliMark size={34} />
          </span>
          <div>
            <h1 className="text-2xl font-black leading-tight tracking-tight">
              {t('home.greeting', { name: user?.email?.split('@')[0] ?? '' }) || t('app.name')}
            </h1>
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('app.tagline')}</p>
          </div>
        </div>
      </section>

      {/* Primary action */}
      <section className="mb-5 space-y-2.5">
        <Link href={`/${locale}/services`} className="btn btn-primary btn-block !text-base">
          <CategoryIcon name="plus" size={21} />
          {t('catalog.requestNow')}
        </Link>
        {ready && user && (
          <div className="grid grid-cols-2 gap-2.5">
            <Link href={`/${locale}/requests`} className="btn btn-secondary">
              <CategoryIcon name="checklist" size={18} />
              {t('request.myTitle')}
            </Link>
            <Link
              href={user.role === 'PROVIDER' ? `/${locale}/provider/dashboard` : `/${locale}/dashboard`}
              className="btn btn-secondary"
            >
              <CategoryIcon name="home" size={18} />
              {user.role === 'PROVIDER' ? t('nav.providerDash') : t('nav.dashboard')}
            </Link>
          </div>
        )}
        {ready && !user && (
          <div className="grid grid-cols-2 gap-2.5">
            <Link href={`/${locale}/register`} className="btn btn-secondary">
              {t('common.signUp')}
            </Link>
            <Link href={`/${locale}/login`} className="btn btn-secondary">
              {t('common.signIn')}
            </Link>
          </div>
        )}
      </section>

      {/* Categories — the same card language as the service picker. */}
      {categories.length > 0 && (
        <section className="mb-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-extrabold tracking-tight">{t('catalog.allCategories')}</h2>
            <Link
              href={`/${locale}/services`}
              className="text-sm font-bold text-[rgb(var(--brand-700))]"
            >
              {t('common.continue')}
            </Link>
          </div>

          <div className="grid gap-2.5">
            {categories.map((category, i) => {
              const count = counts[category.id] ?? 0;
              return (
                <Link
                  key={category.id}
                  href={`/${locale}/services`}
                  className="card card-tap slide-in flex items-center gap-3.5 p-3.5"
                  style={{ animationDelay: `${i * 45}ms` }}
                >
                  <span className="icon-tile h-14 w-14">
                    <CategoryIcon name={iconForSlug(category.slug, category.icon)} size={26} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.9375rem] font-bold">
                      {localized(category, locale)}
                    </span>
                    <span className="mt-0.5 block text-xs font-semibold text-[rgb(var(--brand-700))]">
                      {count > 0
                        ? t('catalog.providersAvailable', { count: count.toLocaleString('ar-MA') })
                        : t('catalog.noProvidersYet')}
                    </span>
                  </span>
                  <CategoryIcon
                    name="chevron"
                    size={20}
                    className="flex-none text-[rgb(var(--fg-subtle))] rtl:rotate-180"
                  />
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Popular services — a shortcut past the catalogue. */}
      {popular.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 text-lg font-extrabold tracking-tight">{t('catalog.popular')}</h2>
          <div className="no-scrollbar -mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1">
            {popular.map((service) => (
              <Link
                key={service.id}
                href={`/${locale}/requests/new?service=${encodeURIComponent(service.slug)}`}
                className="card card-tap flex w-[9.5rem] flex-none flex-col gap-2.5 p-3.5"
              >
                <span className="icon-tile h-11 w-11">
                  <CategoryIcon name={iconForSlug(service.slug)} size={22} />
                </span>
                <span className="line-clamp-2 text-sm font-bold leading-snug">
                  {localized(service, locale)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* How it works — three steps, same card language. */}
      <section className="mb-5">
        <h2 className="mb-3 text-lg font-extrabold tracking-tight">{t('home.howItWorks')}</h2>
        <div className="grid gap-2.5">
          {[
            { icon: 'plus', title: t('home.step1'), hint: t('home.step1Hint') },
            { icon: 'radar', title: t('home.step2'), hint: t('home.step2Hint') },
            { icon: 'check', title: t('home.step3'), hint: t('home.step3Hint') },
          ].map((step, i) => (
            <div key={step.title} className="card flex items-start gap-3.5 p-3.5">
              <span className="icon-tile h-11 w-11 text-base font-black">{i + 1}</span>
              <span>
                <span className="block text-sm font-bold">{step.title}</span>
                <span className="block text-xs text-[rgb(var(--fg-muted))]">{step.hint}</span>
              </span>
              <CategoryIcon
                name={step.icon}
                size={20}
                className="ms-auto flex-none text-[rgb(var(--brand-700))]"
              />
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-[rgb(var(--line))] pt-5 text-center">
        <div className="mb-2 flex justify-center">
          <KhdemliMark size={28} />
        </div>
        <p className="text-xs font-semibold text-[rgb(var(--fg-subtle))]">{t('app.copyright', { year: new Date().getFullYear() })}</p>
      </footer>
    </div>
  );
}
