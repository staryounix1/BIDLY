'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { providersApi, type ProviderProfile, type ProviderService, type ProviderArea, type AvailabilitySlot, type ProviderDocument, type ProviderDocumentType } from '@/lib/providers-api';
import { catalogApi, localized, type Service } from '@/lib/catalog-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Provider profile (sprint 5 foundation).
 *
 * A provider creates their profile, then activates the catalogue services they
 * offer. Activating a service is what makes matching feed requests appear and
 * what makes the server accept their offers. Verification to ACTIVE is an admin
 * step handled elsewhere; this screen only reflects the status.
 */
export default function ProviderProfilePage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN', 'CUSTOMER']}>
      <ProfileView />
    </RequireAuth>
  );
}

function ProfileView() {
  const { t, locale } = useI18n();
  const [profile, setProfile] = useState<ProviderProfile | null | undefined>(undefined);
  const [services, setServices] = useState<ProviderService[]>([]);
  const [areas, setAreas] = useState<ProviderArea[]>([]);
  const [availability, setAvailability] = useState<AvailabilitySlot[]>([]);
  const [documents, setDocuments] = useState<ProviderDocument[]>([]);
  const [catalog, setCatalog] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [selectedService, setSelectedService] = useState('');
  const [areaRadius, setAreaRadius] = useState('15');
  const [slotWeekday, setSlotWeekday] = useState('1');
  const [slotStart, setSlotStart] = useState('09:00');
  const [slotEnd, setSlotEnd] = useState('18:00');
  const [docType, setDocType] = useState<ProviderDocumentType>('IDENTITY');
  const [docUrl, setDocUrl] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await providersApi.me();
      setProfile(me);
      if (me) {
        setDisplayName(me.display_name);
        setBio(me.bio ?? '');
        const [svc, ar, av, docs] = await Promise.all([
          providersApi.myServices(),
          providersApi.myAreas().catch(() => []),
          providersApi.myAvailability().catch(() => []),
          providersApi.myDocuments().catch(() => []),
        ]);
        setServices(svc);
        setAreas(ar);
        setAvailability(av);
        setDocuments(docs);
      }
      const tree = await catalogApi.tree();
      setCatalog(tree.categories.flatMap((c) => c.subcategories.flatMap((s) => s.services)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate() {
    if (displayName.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const created = await providersApi.create({ displayName: displayName.trim(), bio: bio.trim() || undefined });
      setProfile(created);
      setNotice(t('provider.created'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await providersApi.update({ displayName: displayName.trim(), bio: bio.trim() });
      setProfile(updated);
      setNotice(t('common.save'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onAddService() {
    if (!selectedService) return;
    setBusy(true);
    setError(null);
    try {
      const added = await providersApi.upsertService({ serviceId: selectedService, isActive: true });
      setServices((prev) => [...prev.filter((s) => s.service_id !== added.service_id), added]);
      setSelectedService('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveService(serviceId: string) {
    setBusy(true);
    setError(null);
    try {
      await providersApi.removeService(serviceId);
      setServices((prev) => prev.filter((s) => s.service_id !== serviceId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onAddArea() {
    const radius = Number(areaRadius);
    setBusy(true);
    setError(null);
    try {
      const added = await providersApi.addArea({ radiusKm: Number.isFinite(radius) ? radius : undefined });
      setAreas((prev) => [...prev, added]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onAddSlot() {
    setBusy(true);
    setError(null);
    try {
      const saved = await providersApi.setAvailability({
        weekday: Number(slotWeekday),
        startTime: slotStart,
        endTime: slotEnd,
      });
      setAvailability((prev) => {
        const rest = prev.filter(
          (s) => !(s.weekday === saved.weekday && s.start_time === saved.start_time),
        );
        return [...rest, saved];
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitDocument() {
    if (!docUrl.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await providersApi.submitDocument({ type: docType, fileUrl: docUrl.trim() });
      setDocuments((prev) => [saved, ...prev]);
      setDocUrl('');
      setNotice(t('provider.documentSubmitted'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-3xl px-4 py-10 opacity-60">{t('common.loading')}</main>;
  }

  const isNew = profile === null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">{t('provider.title')}</h1>
        <p className="mt-1 text-sm opacity-70">{t('provider.subtitle')}</p>
      </header>

      {notice && (
        <p className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {profile && (
        <div className="mb-5 flex flex-wrap items-center gap-3 text-xs">
          <span className="opacity-70">{t('provider.status')}:</span>
          <StatusBadge status={profile.status} />
          <span className="opacity-70">{t('provider.verification')}:</span>
          <StatusBadge status={profile.verification_status} />
          {profile.rating_avg != null && (
            <span className="opacity-70">
              {t('provider.rating')}: {Number(profile.rating_avg).toFixed(1)} · {t('provider.completedJobs')}:{' '}
              {profile.completed_jobs ?? 0}
            </span>
          )}
        </div>
      )}

      <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
        <label className="block text-sm">
          <span className="opacity-70">{t('provider.displayName')}</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
          />
        </label>
        <label className="mt-4 block text-sm">
          <span className="opacity-70">{t('provider.bio')}</span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
          />
        </label>
        <button
          onClick={isNew ? onCreate : onSave}
          disabled={busy || displayName.trim().length < 2}
          className="mt-4 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
        >
          {isNew ? t('provider.create') : t('common.save')}
        </button>
      </section>

      {!isNew && (
        <section className="mt-6 rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <h2 className="font-semibold">{t('provider.services')}</h2>
          {services.length === 0 ? (
            <p className="mt-2 text-sm opacity-60">{t('offer.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {services.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15"
                >
                  <span>{localized(s, locale)}</span>
                  <button
                    onClick={() => onRemoveService(s.service_id)}
                    disabled={busy}
                    className="text-xs text-rose-700 underline disabled:opacity-50 dark:text-rose-300"
                  >
                    {t('common.cancel')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <select
              value={selectedService}
              onChange={(e) => setSelectedService(e.target.value)}
              className="flex-1 rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none dark:border-white/20"
            >
              <option value="">—</option>
              {catalog.map((s) => (
                <option key={s.id} value={s.id}>
                  {localized(s, locale)}
                </option>
              ))}
            </select>
            <button
              onClick={onAddService}
              disabled={busy || !selectedService}
              className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
            >
              {t('common.save')}
            </button>
          </div>
        </section>
      )}

      {!isNew && (
        <section className="mt-6 rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <h2 className="font-semibold">{t('provider.areas')}</h2>
          <p className="mt-1 text-xs opacity-60">{t('provider.areasHint')}</p>
          {areas.length === 0 ? (
            <p className="mt-2 text-sm opacity-60">{t('common.none')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {areas.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15">
                  <span>{a.city_name ?? '—'}</span>
                  <span className="opacity-60">
                    {a.radius_km} km
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              type="number"
              min="1"
              max="200"
              value={areaRadius}
              onChange={(e) => setAreaRadius(e.target.value)}
              className="w-32 rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none dark:border-white/20"
            />
            <button
              onClick={() => void onAddArea()}
              disabled={busy}
              className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
            >
              {t('provider.addArea')}
            </button>
          </div>
        </section>
      )}

      {!isNew && (
        <section className="mt-6 rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <h2 className="font-semibold">{t('provider.availability')}</h2>
          <p className="mt-1 text-xs opacity-60">{t('provider.availabilityHint')}</p>
          {availability.length === 0 ? (
            <p className="mt-2 text-sm opacity-60">{t('common.none')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {availability.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15">
                  <span>{t(`provider.weekdays.${s.weekday ?? 0}`)}</span>
                  <span className="opacity-70">
                    {s.start_time} – {s.end_time}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <select
              value={slotWeekday}
              onChange={(e) => setSlotWeekday(e.target.value)}
              className="rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
            >
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <option key={d} value={d}>
                  {t(`provider.weekdays.${d}`)}
                </option>
              ))}
            </select>
            <input
              type="time"
              value={slotStart}
              onChange={(e) => setSlotStart(e.target.value)}
              className="rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
            />
            <input
              type="time"
              value={slotEnd}
              onChange={(e) => setSlotEnd(e.target.value)}
              className="rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
            />
            <button
              onClick={() => void onAddSlot()}
              disabled={busy}
              className="rounded-lg border border-black/15 px-4 py-2 font-medium disabled:opacity-50 dark:border-white/20"
            >
              {t('provider.addSlot')}
            </button>
          </div>
        </section>
      )}

      {!isNew && (
        <section className="mt-6 rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <h2 className="font-semibold">{t('provider.documents')}</h2>
          <p className="mt-1 text-xs opacity-60">{t('provider.documentsHint')}</p>
          {documents.length === 0 ? (
            <p className="mt-2 text-sm opacity-60">{t('provider.noDocuments')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15">
                  <span>{d.type}</span>
                  <span className="text-xs opacity-70">
                    {d.rejection_reason ?? t(`provider.docStatus.${d.status}`)}
                  </span>
                  <StatusBadge status={d.status} />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as ProviderDocumentType)}
              className="rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
            >
              {(['IDENTITY', 'BUSINESS', 'LICENSE', 'INSURANCE', 'CERTIFICATION'] as const).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <input
              value={docUrl}
              onChange={(e) => setDocUrl(e.target.value)}
              placeholder={t('provider.documentUrl')}
              className="min-w-0 flex-1 rounded-lg border border-black/15 bg-transparent px-3 py-2 outline-none dark:border-white/20"
            />
            <button
              onClick={() => void onSubmitDocument()}
              disabled={busy || !docUrl.trim()}
              className="rounded-lg border border-black/15 px-4 py-2 font-medium disabled:opacity-50 dark:border-white/20"
            >
              {t('provider.submitDocument')}
            </button>
          </div>
        </section>
      )}

      {!isNew && (
        <section className="mt-6 rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <h2 className="font-semibold">{t('provider.vehicle')}</h2>
          <p className="mt-1 text-xs opacity-60">{t('provider.vehicleHint')}</p>
        </section>
      )}

      {!isNew && (
        <div className="mt-6 flex flex-wrap gap-4 text-sm">
          <Link href={`/${locale}/provider/dashboard`} className="underline">
            {t('providerDash.title')} →
          </Link>
          <Link href={`/${locale}/provider/requests`} className="underline">
            {t('feed.title')} →
          </Link>
        </div>
      )}
    </main>
  );
}
