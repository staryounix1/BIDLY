'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { providersApi, type ProviderProfile, type ProviderService, type ProviderArea, type AvailabilitySlot, type ProviderDocument, type ProviderDocumentType } from '@/lib/providers-api';
import { catalogApi, localized, type Service } from '@/lib/catalog-api';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { SectionTitle, Spinner, Stars } from '@/lib/ui';

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
    return (
      <div className="app-shell container-page py-5">
        <div className="card flex items-center justify-center gap-2 px-5 py-10 text-sm text-[rgb(var(--fg-muted))]">
          <Spinner size={18} />
          {t('common.loading')}
        </div>
      </div>
    );
  }

  const isNew = profile === null;

  return (
    <div className="app-shell container-page py-5">
      <header className="mb-5">
        <h1 className="text-2xl font-extrabold tracking-tight">{t('provider.title')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('provider.subtitle')}</p>
      </header>

      {notice && (
        <div className="card mb-4 flex items-center gap-2 border-[rgb(var(--ok)/0.35)] p-3 text-sm text-[rgb(var(--ok))]">
          <CategoryIcon name="check" size={16} />
          <span className="flex-1">{notice}</span>
        </div>
      )}
      {error && (
        <div className="card mb-4 flex items-center gap-2 border-[rgb(var(--danger)/0.35)] p-3 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={16} />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {profile && (
        <div className="card mb-5 flex flex-wrap items-center gap-3 p-4 text-xs">
          <span className="font-semibold text-[rgb(var(--fg-muted))]">{t('provider.status')}:</span>
          <StatusBadge status={profile.status} />
          <span className="font-semibold text-[rgb(var(--fg-muted))]">{t('provider.verification')}:</span>
          <StatusBadge status={profile.verification_status} />
          {profile.rating_avg != null && (
            <span className="flex flex-wrap items-center gap-2 text-[rgb(var(--fg-muted))]">
              <span className="font-semibold">{t('provider.rating')}:</span>
              <Stars value={Number(profile.rating_avg)} />
              <span>
                {t('provider.completedJobs')}: <span className="tnum font-bold">{profile.completed_jobs ?? 0}</span>
              </span>
            </span>
          )}
        </div>
      )}

      <section className="card p-5">
        <label className="block">
          <span className="label">{t('provider.displayName')}</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="input"
          />
        </label>
        <label className="mt-4 block">
          <span className="label">{t('provider.bio')}</span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            className="input resize-none"
          />
        </label>
        <button
          onClick={isNew ? onCreate : onSave}
          disabled={busy || displayName.trim().length < 2}
          className="btn btn-primary btn-block mt-4"
        >
          {busy ? <Spinner size={18} /> : <CategoryIcon name="check" size={18} />}
          {isNew ? t('provider.create') : t('common.save')}
        </button>
      </section>

      {!isNew && (
        <section className="card mt-5 p-5">
          <SectionTitle>{t('provider.services')}</SectionTitle>
          {services.length === 0 ? (
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('offer.empty')}</p>
          ) : (
            <ul className="space-y-2">
              {services.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[rgb(var(--line))] px-3 py-2.5 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span className="icon-tile h-7 w-7">
                      <CategoryIcon name="wrench" size={14} />
                    </span>
                    {localized(s, locale)}
                  </span>
                  <button
                    onClick={() => onRemoveService(s.service_id)}
                    disabled={busy}
                    className="text-xs font-semibold text-[rgb(var(--danger))] underline disabled:opacity-50"
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
              className="input min-w-0 flex-1"
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
              className="btn btn-secondary"
            >
              {t('common.save')}
            </button>
          </div>
        </section>
      )}

      {!isNew && (
        <section className="card mt-5 p-5">
          <SectionTitle>{t('provider.areas')}</SectionTitle>
          <p className="-mt-2 mb-3 text-xs text-[rgb(var(--fg-subtle))]">{t('provider.areasHint')}</p>
          {areas.length === 0 ? (
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('common.none')}</p>
          ) : (
            <ul className="space-y-2">
              {areas.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[rgb(var(--line))] px-3 py-2.5 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span className="icon-tile h-7 w-7">
                      <CategoryIcon name="pin" size={14} />
                    </span>
                    {a.city_name ?? '—'}
                  </span>
                  <span className="tnum text-[rgb(var(--fg-muted))]">{a.radius_km} km</span>
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
              className="input tnum w-32"
            />
            <button
              onClick={() => void onAddArea()}
              disabled={busy}
              className="btn btn-secondary"
            >
              {t('provider.addArea')}
            </button>
          </div>
        </section>
      )}

      {!isNew && (
        <section className="card mt-5 p-5">
          <SectionTitle>{t('provider.availability')}</SectionTitle>
          <p className="-mt-2 mb-3 text-xs text-[rgb(var(--fg-subtle))]">{t('provider.availabilityHint')}</p>
          {availability.length === 0 ? (
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('common.none')}</p>
          ) : (
            <ul className="space-y-2">
              {availability.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[rgb(var(--line))] px-3 py-2.5 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span className="icon-tile h-7 w-7">
                      <CategoryIcon name="clock" size={14} />
                    </span>
                    {t(`provider.weekdays.${s.weekday ?? 0}`)}
                  </span>
                  <span className="tnum text-[rgb(var(--fg-muted))]">
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
              className="input w-auto"
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
              className="input w-auto"
            />
            <input
              type="time"
              value={slotEnd}
              onChange={(e) => setSlotEnd(e.target.value)}
              className="input w-auto"
            />
            <button
              onClick={() => void onAddSlot()}
              disabled={busy}
              className="btn btn-secondary"
            >
              {t('provider.addSlot')}
            </button>
          </div>
        </section>
      )}

      {!isNew && (
        <section className="card mt-5 p-5">
          <SectionTitle>{t('provider.documents')}</SectionTitle>
          <p className="-mt-2 mb-3 text-xs text-[rgb(var(--fg-subtle))]">{t('provider.documentsHint')}</p>
          {documents.length === 0 ? (
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('provider.noDocuments')}</p>
          ) : (
            <ul className="space-y-2">
              {documents.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[rgb(var(--line))] px-3 py-2.5 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span className="icon-tile h-7 w-7">
                      <CategoryIcon name="doc" size={14} />
                    </span>
                    {d.type}
                  </span>
                  <span className="text-xs text-[rgb(var(--fg-muted))]">
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
              className="input w-auto"
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
              className="input min-w-0 flex-1"
              dir="ltr"
            />
            <button
              onClick={() => void onSubmitDocument()}
              disabled={busy || !docUrl.trim()}
              className="btn btn-secondary"
            >
              {t('provider.submitDocument')}
            </button>
          </div>
        </section>
      )}

      {!isNew && (
        <section className="card mt-5 p-5">
          <SectionTitle>{t('provider.vehicle')}</SectionTitle>
          <p className="-mt-2 text-xs text-[rgb(var(--fg-subtle))]">{t('provider.vehicleHint')}</p>
        </section>
      )}

      {!isNew && (
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href={`/${locale}/provider/dashboard`} className="btn btn-secondary btn-lg">
            {t('providerDash.title')}
          </Link>
          <Link href={`/${locale}/provider/requests`} className="btn btn-secondary btn-lg">
            {t('feed.title')}
          </Link>
        </div>
      )}
    </div>
  );
}
