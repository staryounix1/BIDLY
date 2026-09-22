'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Map as LeafletMap } from 'leaflet';
import { useI18n } from '@/lib/i18n-provider';
import { useAuth } from '@/lib/auth-provider';
import { catalogApi, localized, type Category } from '@/lib/catalog-api';
import { CategoryIcon, iconForSlug, KhdemliMark } from '@/lib/icons';
import { useMyLocation } from '@/lib/map/use-my-location';
import { MapView, DEFAULT_MAP_STYLE } from '@/lib/map/map-view';
import { BottomSheet, type SheetDetent } from '@/lib/map/bottom-sheet';

/**
 * Customer home — the map IS the page.
 *
 * The design puts supply, location and the one action (ask for something) on a
 * single screen instead of a scroll: a full-bleed map behind a floating tray.
 * That is the same contract as `/requests/new`, so both screens inherit the
 * same CSS and the same "the map never scrolls away" behaviour.
 *
 * Only a signed-in customer sees this. A provider or an admin gets the
 * stacked dashboard home, because their job is not to request a service.
 */

/**
 * The six crafts the customer can ask for, in display order.
 *
 * Each one is a real subcategory in the database (`slug`), so tapping through
 * lands on a filter that actually has services behind it, and the icon is the
 * craft's own glyph — not a guess from the name.
 */
const CRAFTS = [
  { slug: 'painting', icon: 'roller', ar: 'صباغ', en: 'Painter', fr: 'Peintre' },
  { slug: 'plasterer', icon: 'trowel', ar: 'جباص', en: 'Plasterer', fr: 'Plâtrier' },
  { slug: 'mason', icon: 'bricks', ar: 'طريسيان', en: 'Mason', fr: 'Maçon' },
  { slug: 'plumbing', icon: 'plunger', ar: 'بلومبي', en: 'Plumber', fr: 'Plombier' },
  { slug: 'tiler', icon: 'tiles', ar: 'زليج', en: 'Tiler', fr: 'Carreleur' },
  { slug: 'tailor', icon: 'needle', ar: 'خياط', en: 'Tailor', fr: 'Couturier' },
] as const;

type CraftTile = {
  id: string;
  slug: string;
  icon: string;
  name_ar: string;
  name_en: string;
  name_fr: string;
};

/** Header height is measured, because the header is global chrome, not ours. */
function useHeaderOffset() {  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const measure = () => {
      const header = document.querySelector('header');
      setOffset(header ? header.getBoundingClientRect().height : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    // The header grows once auth resolves (notifications, profile, sign-out).
    const timer = window.setTimeout(measure, 400);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearTimeout(timer);
    };
  }, []);
  return offset;
}

export default function HomePage() {
  const { t, locale } = useI18n();
  const { user, ready } = useAuth();

  const isCustomer = ready && user?.role === 'CUSTOMER';
  if (!isCustomer) return <StackedHome />;
  return <MapHome />;
}

/* ------------------------------------------------------------------ */
/* The customer's screen                                               */
/* ------------------------------------------------------------------ */

function MapHome() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const headerOffset = useHeaderOffset();

  const [categories, setCategories] = useState<Category[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const mapRef = useRef<LeafletMap | null>(null);

  // The customer's own position drives the map centre and the bubble ring.
  const { position, center, initialCenter, status } = useMyLocation({ watch: true });

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
        setCounts(providerCounts.byCategory ?? {});
      } catch {
        // A failed catalogue must not blank the map.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // The tiles are the six customer-facing crafts, in the order the business
  // wants them, matching the icon set one-to-one. The database's own
  // top-level categories (home / moving / personal) are too coarse to pick a
  // tradesman from, so this list is data-owned here rather than by `categories`.
  const tiles = useMemo<CraftTile[]>(
    () =>
      CRAFTS.map((c) => ({
        id: c.slug,
        slug: c.slug,
        icon: c.icon,
        name_ar: c.ar,
        name_en: c.en,
        name_fr: c.fr,
      })),
    [],
  );

  /**
   * Bubbles ride the *visible* band of map, not the whole viewport.
   *
   * The tray covers the lower part of the screen, so a fixed percentage of the
   * viewport would put half the bubbles underneath it — which is exactly what
   * happened first: three pins, one visible. The band is measured from the
   * mapped area under the header down to the top of the sheet, and it shrinks
   * as the sheet is dragged up (`detent`), so nothing is ever hidden.
   */
  const [detent, setDetent] = useState<SheetDetent>('peek');
  const sheetShare = detent === 'full' ? 0.92 : detent === 'half' ? 0.66 : 0.4;

  const bubbles = useMemo(() => {
    const n = tiles.length || 1;
    // Ring geometry as a share of the band, so it scales with the screen.
    return tiles.map((c, i) => {
      const angle = (-90 + (360 / n) * i) * (Math.PI / 180);
      return {
        category: c,
        // x/y are percentages of the map band; see the wrapper's geometry.
        x: 50 + Math.cos(angle) * 32,
        y: 50 + Math.sin(angle) * 30,
        // A slight stagger keeps neighbouring bubbles from overlapping.
        scale: 1 - (i % 3) * 0.04,
      };
    });
  }, [tiles]);

  const onMapReady = useCallback((map: LeafletMap) => {
    mapRef.current = map;
  }, []);

  const totalProviders = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );

  // The map mounts at the remembered centre straight away, then follows the
  // live fix. `MapContainer` only reads `center`/`zoom` once, so the live
  // position has to arrive through `view`, or the map keeps showing wherever
  // the customer happened to be last time (and stays there for the session).
  const startCenter: [number, number] = [initialCenter.lat, initialCenter.lng];

  function onSubmitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(`/${locale}/services${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  }

  function requestService(slug?: string | null) {
    router.push(
      slug
        ? `/${locale}/requests/new?service=${encodeURIComponent(slug)}`
        : `/${locale}/services`,
    );
  }

  return (
    <>
      {/* The map fills the viewport, starting under the global header. */}
      <div className="home-map" style={{ insetBlockStart: headerOffset }}>
        <MapView
          center={startCenter}
          zoom={14}
          style={DEFAULT_MAP_STYLE}
          className="h-full w-full"
          onReady={onMapReady}
          view={position ? { center: [position.lat, position.lng], zoom: 14, animate: true } : undefined}
        >
        </MapView>

        {/*
          The bubbles live inside a band that stops where the tray begins, so
          every pin stays on visible map however far the sheet is dragged up.
          The dot marks the customer's own position at the band's centre.
        */}
        <div className="home-band" style={{ bottom: `${sheetShare * 100}%` }}>
          {bubbles.map(({ category, x, y, scale }) => {
            const isActive = active === category.id;
            return (
              <button
                key={category.id}
                type="button"
                className={`home-bubble ${isActive ? 'home-bubble--active' : ''}`}
                style={{ left: `${x}%`, top: `${y}%`, transform: `translate(-50%, -50%) scale(${scale})` }}
                aria-label={localized(category, locale)}
                aria-pressed={isActive}
                onClick={() => setActive(isActive ? null : category.id)}
              >
                <CategoryIcon name={iconForSlug(category.slug, category.icon)} size={24} />
              </button>
            );
          })}

          {/* "You are here" — the centre of the ring. */}
          <span className="home-here" aria-hidden>
            <span className="home-here-dot" />
          </span>
        </div>
      </div>

      {/* Floating chrome over the map: bell, brand, profile. */}
      <div
        className="pointer-events-none fixed inset-x-0 z-30 flex items-center justify-between px-3"
        style={{ top: headerOffset + 10 }}
      >
        <button
          type="button"
          className="home-pill home-pill--icon pointer-events-auto"
          onClick={() => router.push(`/${locale}/notifications`)}
          aria-label={t('nav.notifications')}
        >
          <CategoryIcon name="bell" size={20} />
        </button>

        <span className="home-pill pointer-events-auto">
          <KhdemliMark size={20} />
          <span className="font-black tracking-tight">{t('app.name')}</span>
        </span>

        <Link
          href={`/${locale}/profile`}
          className="home-pill home-pill--icon pointer-events-auto"
          aria-label={t('nav.profile')}
        >
          <CategoryIcon name="user" size={20} />
        </Link>
      </div>

      {/* Recenter on the customer's dot once we know where they are. */}
      {position && (
        <button
          type="button"
          className="home-pill home-pill--icon fixed start-3 z-[910]"
          style={{ bottom: `calc(${sheetShare * 100}vh + 0.75rem)` }}
          aria-label={t('map.recenter')}
          onClick={() => mapRef.current?.flyTo([position.lat, position.lng], 14, { duration: 0.6 })}
        >
          <CategoryIcon name="nav" size={19} />
        </button>
      )}

      <BottomSheet
        initial="peek"
        bottomOffset={headerOffset}
        label={t('home.askTitle')}
        className="compose-sheet"
        onDetentChange={setDetent}
      >
        <div className="space-y-4 pt-1">
          <div className="text-center">
            <h1 className="text-2xl font-black tracking-tight">{t('home.askTitle')}</h1>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-[rgb(var(--fg-muted))]">
              {t('home.askSubtitle')}
            </p>
          </div>

          <form onSubmit={onSubmitSearch} className="relative">
            <CategoryIcon
              name="search"
              size={19}
              className="pointer-events-none absolute inset-y-0 start-4 my-auto text-[rgb(var(--fg-subtle))]"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('home.searchPlaceholder')}
              className="input !ps-11 !py-3.5"
              aria-label={t('home.searchPlaceholder')}
            />
          </form>

          {tiles.length > 0 && (
            <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {tiles.map((c) => {
                const isActive = active === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`home-cat ${isActive ? 'home-cat--active' : ''}`}
                    onClick={() => {
                      setActive(isActive ? null : c.id);
                      mapRef.current?.flyTo([center.lat, center.lng], 14, { duration: 0.5 });
                    }}
                  >
                    <span className="home-cat-tile">
                      <CategoryIcon name={iconForSlug(c.slug, c.icon)} size={22} />
                    </span>
                    <span className="max-w-[4.75rem] truncate">{localized(c, locale)}</span>
                  </button>
                );
              })}
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary btn-block !text-base"
            onClick={() => requestService(active ? tiles.find((c) => c.id === active)?.slug : null)}
          >
            <CategoryIcon name="plus" size={20} />
            {active
              ? t('home.requestCategory', { name: localized(tiles.find((c) => c.id === active)!, locale) })
              : t('catalog.requestNow')}
          </button>

          <p className="flex items-center justify-center gap-2 text-xs font-semibold text-[rgb(var(--fg-subtle))]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {t('home.providersNearbyActive', { count: totalProviders.toLocaleString('ar-MA') })}
          </p>

          {status === 'denied' && (
            <p className="text-center text-xs text-[rgb(var(--fg-subtle))]">{t('map.denied')}</p>
          )}
        </div>
      </BottomSheet>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Provider / admin / signed-out home — the previous stacked page       */
/* ------------------------------------------------------------------ */

function StackedHome() {
  const { t, locale } = useI18n();
  const { user, ready } = useAuth();
  const [categories, setCategories] = useState<Category[]>([]);
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
        setCounts(providerCounts.byCategory ?? {});
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

      {categories.length > 0 && (
        <section className="mb-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-extrabold tracking-tight">{t('catalog.allCategories')}</h2>
            <Link href={`/${locale}/services`} className="text-sm font-bold text-[rgb(var(--brand-700))]">
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
        <p className="text-xs font-semibold text-[rgb(var(--fg-subtle))]">
          {t('app.copyright', { year: new Date().getFullYear() })}
        </p>
      </footer>
    </div>
  );
}
