'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import {
  catalogApi,
  fieldHelp,
  fieldLabel,
  fieldPlaceholder,
  localized,
  optionLabel,
  type City,
  type Service,
  type ServiceField,
} from '@/lib/catalog-api';
import { requestsApi } from '@/lib/requests-api';
import { MapPicker } from '@/lib/map/map-picker';
import { BottomSheet, type SheetDetent } from '@/lib/map/bottom-sheet';
import { createRequestSchema, validateServiceAnswers } from '@bidly/validation';
import { CategoryIcon, iconForSlug } from '@/lib/icons';
import { PriceStepper, Spinner } from '@/lib/ui';

/**
 * Compose a request — the inDrive shape.
 *
 * The map is the page: it fills the viewport under the app header, edge to
 * edge. The service title floats over it as a thin translucent bar, and every
 * control lives on a draggable bottom sheet so the customer can always see
 * where the job is while they set the price.
 *
 * The form itself is unchanged from the vertical version — same dynamic
 * service fields, same validation, same payload. Only the presentation moved
 * from a long scroll into a tray with snap points.
 */

/** Header height is measured, because the header is global chrome, not ours. */
function useHeaderOffset() {
  const [offset, setOffset] = useState(0);
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

export default function NewRequestPage() {
  return (
    <RequireAuth roles={['CUSTOMER']}>
      <NewRequestView />
    </RequireAuth>
  );
}

function NewRequestView() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const serviceSlug = params.get('service');
  const headerOffset = useHeaderOffset();

  const [service, setService] = useState<
    (Service & { category_slug: string; subcategory_slug: string }) | null
  >(null);
  const [fields, setFields] = useState<ServiceField[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState('NORMAL');
  const [price, setPrice] = useState(0);
  const [scheduledAt, setScheduledAt] = useState('');
  const [itemCount, setItemCount] = useState('');
  const [requiresHelper, setRequiresHelper] = useState(false);

  const [pickup, setPickup] = useState({ line1: '', district: '', cityId: '', notes: '' });
  const [destination, setDestination] = useState({ line1: '', cityId: '', notes: '' });
  const [pickupPoint, setPickupPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [destinationPoint, setDestinationPoint] = useState<{ lat: number; lng: number } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [detent, setDetent] = useState<SheetDetent>('peek');

  // Guards a second submit before React re-renders the disabled button — a slow
  // tap on mobile can otherwise create the request twice.
  const inFlight = useRef(false);

  // The map is the page background, so the page itself must not scroll away
  // from it while the sheet is open.
  useEffect(() => {
    document.body.classList.add('compose-locked');
    return () => document.body.classList.remove('compose-locked');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cityList] = await Promise.all([catalogApi.cities()]);
        if (!cancelled) setCities(cityList);
        if (serviceSlug) {
          const form = await catalogApi.serviceForm(serviceSlug);
          if (!cancelled) {
            setService(form.service);
            setFields(form.fields);
            const defaults: Record<string, unknown> = {};
            for (const f of form.fields) {
              if (f.default_value != null) defaults[f.key] = f.default_value;
            }
            setAnswers(defaults);
            // Seed the stepper from the service's own floor so the first number
            // the customer sees is a sane one, not zero.
            setPrice(Math.round((form.service.min_price_minor ?? 10000) / 100));
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceSlug, t]);

  const setAnswer = useCallback((key: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }, []);

  // The map owns the pickup address, so a required ADDRESS answer should follow
  // it instead of asking the customer to type the same street twice.
  const addressFieldKey = useMemo(
    () => fields.find((f) => f.type === 'ADDRESS')?.key,
    [fields],
  );
  useEffect(() => {
    if (!addressFieldKey) return;
    const line1 = (service?.requires_location ? pickup : destination).line1.trim();
    if (!line1) return;
    setAnswers((prev) =>
      prev[addressFieldKey] === line1 ? prev : { ...prev, [addressFieldKey]: line1 },
    );
  }, [addressFieldKey, service?.requires_location, pickup, destination]);

  const visibleFields = useMemo(
    () =>
      fields.filter((f) => {
        // The map already answers the ADDRESS field; showing a second box for
        // the same street is the kind of duplication that loses a customer.
        if (f.type === 'ADDRESS') return false;
        if (!f.depends_on_key) return true;
        const dependency = answers[f.depends_on_key];
        return String(dependency ?? '') === String(f.depends_on_value ?? '');
      }),
    [fields, answers],
  );

  const currency = service?.default_currency ?? 'MAD';
  const needsLocation = Boolean(service?.requires_location);
  const needsDestination = Boolean(service?.requires_destination);

  // Validation errors are useless inside a collapsed tray, so surface them.
  useEffect(() => {
    if (submitError && detent === 'peek') setDetent('half');
  }, [submitError, detent]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!service) return;
    if (inFlight.current) return;
    setSubmitError(null);

    // Client-side required checks; the API re-validates everything.
    const nextErrors: Record<string, string> = {};
    if (service.requires_location && !pickup.line1.trim()) nextErrors.pickup = t('request.answerRequired');
    if (service.requires_destination && !destination.line1.trim()) {
      nextErrors.destination = t('request.answerRequired');
    }
    if (price <= 0) nextErrors.price = t('request.answerRequired');
    if (Object.keys(nextErrors).length > 0) {
      setFormErrors(nextErrors);
      setSubmitError(t('request.answerRequired'));
      return;
    }
    setFormErrors({});

    const fieldErrors = validateServiceAnswers(fields, answers);
    if (Object.keys(fieldErrors).length > 0) {
      setAnswerErrors(fieldErrors);
      setSubmitError(t('request.answerRequired'));
      return;
    }
    setAnswerErrors({});

    const priceMinor = Math.round(price * 100);
    const payload = {
      serviceId: service.id,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      answers,
      budgetMinMinor: priceMinor,
      budgetMaxMinor: priceMinor,
      currency: service.default_currency,
      urgency,
      ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      ...(itemCount ? { itemCount: Number(itemCount) } : {}),
      requiresHelper,
      ...(service.requires_location && pickup.line1
        ? {
            pickup: {
              line1: pickup.line1,
              ...(pickup.district ? { district: pickup.district } : {}),
              ...(pickup.cityId ? { cityId: pickup.cityId } : {}),
              ...(pickupPoint ? { lat: pickupPoint.lat, lng: pickupPoint.lng } : {}),
              ...(pickup.notes ? { notes: pickup.notes } : {}),
            },
          }
        : {}),
      ...(service.requires_destination && destination.line1
        ? {
            destination: {
              line1: destination.line1,
              ...(destination.cityId ? { cityId: destination.cityId } : {}),
              ...(destinationPoint ? { lat: destinationPoint.lat, lng: destinationPoint.lng } : {}),
              ...(destination.notes ? { notes: destination.notes } : {}),
            },
          }
        : {}),
    };

    const parsed = createRequestSchema.safeParse(payload);
    if (!parsed.success) {
      setSubmitError(parsed.error.issues[0]?.message ?? t('common.error'));
      return;
    }

    setSubmitting(true);
    inFlight.current = true;
    try {
      const created = await requestsApi.create(parsed.data);
      router.push(`/${locale}/requests/${created.id}?created=1`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : t('common.error'));
      inFlight.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-[70vh] place-items-center">
        <Spinner size={28} />
      </div>
    );
  }

  if (!serviceSlug || !service) {
    return (
      <div className="app-shell container-page py-6">
        <h1 className="text-2xl font-black tracking-tight">{t('compose.title')}</h1>
        {loadError && <p className="mt-3 text-sm text-[rgb(var(--danger))]">{loadError}</p>}
        <ServicePicker />
      </div>
    );
  }

  return (
    <>
      {/* The map IS the page: fixed, full viewport, starting under the header
          and running to the very bottom edge. */}
      <div
        className="compose-map"
        style={{ insetBlockStart: headerOffset }}
        aria-hidden={false}
      >
        {needsLocation || needsDestination ? (
          <MapPicker
            value={needsLocation ? pickupPoint : destinationPoint}
            onChange={(p: { lat: number; lng: number } | null) => {
              if (needsLocation) {
                setPickupPoint(p);
                setFormErrors((prev) => ({ ...prev, pickup: '' }));
              } else {
                setDestinationPoint(p);
              }
            }}
            address={needsLocation ? pickup.line1 : destination.line1}
            onAddressChange={(line1: string) =>
              needsLocation
                ? setPickup((prev) => ({ ...prev, line1 }))
                : setDestination((prev) => ({ ...prev, line1 }))
            }
            variant="full"
          />
        ) : (
          <div className="map-canvas grid h-full place-items-center">
            <span className="text-sm text-[rgb(var(--fg-muted))]">{t('compose.pickLocation')}</span>
          </div>
        )}
      </div>

      {/* Thin translucent title bar floating directly over the map. */}
      <div className="compose-topbar" style={{ top: headerOffset }}>
        <Link
          href={`/${locale}/services`}
          aria-label={t('common.back')}
          className="btn btn-secondary h-9 w-9 flex-none !p-0"
        >
          <CategoryIcon name="chevron" size={17} className="rotate-180 rtl:rotate-0" />
        </Link>

        <span className="icon-tile h-9 w-9">
          <CategoryIcon name={iconForSlug(service.slug)} size={19} />
        </span>

        <span className="compose-topbar-title">
          <span className="block truncate text-sm font-bold">{localized(service, locale)}</span>
          <span className="block truncate text-[11px] text-[rgb(var(--fg-muted))]">
            {detent === 'peek' ? t('compose.dragHint') : t('compose.mapHint')}
          </span>
        </span>
      </div>

      {/* Everything else lives on the tray. */}
      <BottomSheet
        initial="peek"
        detent={detent}
        onDetentChange={setDetent}
        bottomOffset={headerOffset}
        label={t('compose.title')}
      >
        <form onSubmit={onSubmit} className="space-y-4 pt-1" noValidate>
          {/* Destination / service details — the one text field on the screen. */}
          <label className="block">
            <span className="label">{t('compose.destination')}</span>
            <div className="relative">
              <CategoryIcon
                name="pin"
                size={19}
                className="pointer-events-none absolute inset-y-0 start-3.5 my-auto text-[rgb(var(--brand-700))]"
              />
              <input
                className="input ps-11"
                placeholder={t('compose.destinationPlaceholder')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={140}
              />
            </div>
          </label>

          {/* Your price — the loudest control, and the reason the tray exists. */}
          <div className="rounded-2xl border border-[rgb(var(--line))] p-3.5">
            <PriceStepper
              value={price}
              onChange={setPrice}
              step={10}
              min={0}
              currency={currency}
              label={t('compose.yourPrice')}
            />
            <p className="mt-2 text-center text-xs text-[rgb(var(--fg-subtle))]">{t('compose.priceHint')}</p>
            {formErrors.price && (
              <p className="mt-1 text-center text-xs font-semibold text-[rgb(var(--danger))]">
                {formErrors.price}
              </p>
            )}
          </div>

          <label className="block">
            <span className="label">{t('request.description')}</span>
            <textarea
              className="input min-h-[76px] resize-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={2000}
            />
          </label>

          {submitError && (
            <p
              role="alert"
              className="rounded-xl border border-[rgb(var(--danger)/0.35)] bg-[rgb(var(--danger)/0.08)] px-4 py-3 text-sm font-semibold text-[rgb(var(--danger))]"
            >
              {submitError}
            </p>
          )}

          {/* One loud button, pinned in thumb reach above the safe area. */}
          <button
            type="submit"
            disabled={submitting || price <= 0}
            className="btn btn-primary btn-block sticky bottom-0"
          >
            {submitting ? (
              <>
                <Spinner size={18} />
                {t('compose.sending')}
              </>
            ) : (
              <>
                <CategoryIcon name="arrow" size={20} className="rtl:rotate-180" />
                {t('compose.sendRequest')}
              </>
            )}
          </button>

          {/* ---- deeper detail, below the loud action ---- */}

          {needsLocation && (
            <div className="space-y-3 rounded-2xl border border-[rgb(var(--line))] p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <CategoryIcon name="pin" size={17} className="text-[rgb(var(--brand-700))]" />
                {t('request.pickup')}
              </h2>
              <Field label={t('request.line1')} required error={formErrors.pickup}>
                <input
                  className="input"
                  value={pickup.line1}
                  onChange={(e) => setPickup({ ...pickup, line1: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('request.district')}>
                  <input
                    className="input"
                    value={pickup.district}
                    onChange={(e) => setPickup({ ...pickup, district: e.target.value })}
                  />
                </Field>
                <Field label={t('request.city')}>
                  <CitySelect
                    cities={cities}
                    locale={locale}
                    value={pickup.cityId}
                    onChange={(v) => setPickup({ ...pickup, cityId: v })}
                  />
                </Field>
              </div>
              <Field label={t('request.notes')}>
                <input
                  className="input"
                  value={pickup.notes}
                  onChange={(e) => setPickup({ ...pickup, notes: e.target.value })}
                />
              </Field>
            </div>
          )}

          {needsDestination && (
            <div className="space-y-3 rounded-2xl border border-[rgb(var(--line))] p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <CategoryIcon name="route" size={17} className="text-[rgb(var(--brand-700))]" />
                {t('request.destination')}
              </h2>
              <Field label={t('request.line1')} required error={formErrors.destination}>
                <input
                  className="input"
                  value={destination.line1}
                  onChange={(e) => setDestination({ ...destination, line1: e.target.value })}
                />
              </Field>
              <Field label={t('request.city')}>
                <CitySelect
                  cities={cities}
                  locale={locale}
                  value={destination.cityId}
                  onChange={(v) => setDestination({ ...destination, cityId: v })}
                />
              </Field>
              <Field label={t('request.notes')}>
                <input
                  className="input"
                  value={destination.notes}
                  onChange={(e) => setDestination({ ...destination, notes: e.target.value })}
                />
              </Field>
              <MapPicker
                value={destinationPoint}
                onChange={setDestinationPoint}
                address={destination.line1}
                onAddressChange={(line1: string) => setDestination((prev) => ({ ...prev, line1 }))}
                height={190}
              />
            </div>
          )}

          {/* Urgency / schedule — advanced, collapsed into one compact row. */}
          <div className="rounded-2xl border border-[rgb(var(--line))] p-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="label">{t('request.urgency')}</span>
                <select value={urgency} onChange={(e) => setUrgency(e.target.value)} className="input">
                  {(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).map((u) => (
                    <option key={u} value={u}>
                      {t(`urgency.${u}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">{t('request.scheduledAt')}</span>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="input"
                />
              </label>
            </div>

            <div className="mt-3 grid grid-cols-2 items-end gap-3">
              <label className="block">
                <span className="label">{t('request.itemCount')}</span>
                <input
                  type="number"
                  min="0"
                  value={itemCount}
                  onChange={(e) => setItemCount(e.target.value)}
                  className="input"
                />
              </label>
              <label className="flex items-center gap-2 pb-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={requiresHelper}
                  onChange={(e) => setRequiresHelper(e.target.checked)}
                  className="h-5 w-5 accent-[rgb(var(--brand-500))]"
                />
                {t('request.requiresHelper')}
              </label>
            </div>
          </div>

          {/* Service-specific questions, still data-driven. */}
          {visibleFields.length > 0 && (
            <div className="space-y-4 rounded-2xl border border-[rgb(var(--line))] p-4">
              {visibleFields.map((field) => (
                <ServiceFieldInput
                  key={field.id}
                  field={field}
                  locale={locale}
                  value={answers[field.key]}
                  error={answerErrors[field.key]}
                  onChange={(v) => setAnswer(field.key, v)}
                />
              ))}
            </div>
          )}
        </form>
      </BottomSheet>
    </>
  );
}

function ServicePicker() {
  const { t, locale } = useI18n();
  const [categories, setCategories] = useState<
    Awaited<ReturnType<typeof catalogApi.tree>>['categories']
  >([]);

  useEffect(() => {
    catalogApi
      .tree()
      .then((d) => setCategories(d.categories))
      .catch(() => setCategories([]));
  }, []);

  const services = useMemo(
    () => categories.flatMap((c) => c.subcategories.flatMap((s) => s.services)),
    [categories],
  );

  if (services.length === 0) {
    return <p className="mt-6 text-sm text-[rgb(var(--fg-muted))]">{t('common.loading')}</p>;
  }

  return (
    <div className="mt-5 grid gap-2.5">
      {services.map((s, i) => (
        <Link
          key={s.id}
          href={`/${locale}/requests/new?service=${s.slug}`}
          className="card card-tap slide-in flex items-center gap-3.5 p-3.5"
          style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
        >
          <span className="icon-tile h-12 w-12">
            <CategoryIcon name={iconForSlug(s.slug)} size={23} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-bold">
            {localized(s, locale)}
          </span>
          <CategoryIcon
            name="chevron"
            size={20}
            className="flex-none text-[rgb(var(--fg-subtle))] rtl:rotate-180"
          />
        </Link>
      ))}
    </div>
  );
}

function CitySelect({
  cities,
  locale,
  value,
  onChange,
}: {
  cities: City[];
  locale: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
      <option value="">{t('common.none')}</option>
      {cities.map((c) => (
        <option key={c.id} value={c.id}>
          {localized(
            c as unknown as { name_en: string; name_fr: string | null; name_ar: string | null },
            locale,
          )}
        </option>
      ))}
    </select>
  );
}

function ServiceFieldInput({
  field,
  locale,
  value,
  error,
  onChange,
}: {
  field: ServiceField;
  locale: string;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  const label = fieldLabel(field, locale);
  const placeholder = fieldPlaceholder(field, locale);
  const help = fieldHelp(field, locale);

  if (field.type === 'BOOLEAN') {
    return (
      <label className="flex items-center gap-2.5 text-sm font-semibold">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-5 w-5 accent-[rgb(var(--brand-500))]"
        />
        {label}
      </label>
    );
  }

  if (field.type === 'SELECT') {
    return (
      <Field label={label} required={field.is_required} help={help} error={error}>
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="input"
        >
          <option value="">{placeholder ?? '—'}</option>
          {field.options.map((o) => (
            <option key={o.id} value={o.value}>
              {optionLabel(o, locale)}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.type === 'MULTISELECT') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Field label={label} required={field.is_required} help={help} error={error}>
        <div className="flex flex-wrap gap-2">
          {field.options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                type="button"
                key={o.id}
                onClick={() =>
                  onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])
                }
                className={on ? 'chip chip-brand h-9 px-4' : 'chip chip-neutral h-9 px-4'}
              >
                {optionLabel(o, locale)}
              </button>
            );
          })}
        </div>
      </Field>
    );
  }

  const inputType =
    field.type === 'NUMBER'
      ? 'number'
      : field.type === 'DATE'
        ? 'date'
        : field.type === 'DATETIME'
          ? 'datetime-local'
          : field.type === 'PHONE'
            ? 'tel'
            : 'text';

  if (field.type === 'TEXTAREA' || field.type === 'ADDRESS') {
    return (
      <Field label={label} required={field.is_required} help={help} error={error}>
        <textarea
          value={String(value ?? '')}
          placeholder={placeholder}
          maxLength={field.max_length ?? undefined}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="input resize-none"
        />
      </Field>
    );
  }

  return (
    <Field label={label} required={field.is_required} help={help} error={error}>
      <input
        type={inputType}
        value={String(value ?? '')}
        placeholder={placeholder}
        maxLength={field.max_length ?? undefined}
        min={field.min_value ?? undefined}
        max={field.max_value ?? undefined}
        onChange={(e) => onChange(field.type === 'NUMBER' ? Number(e.target.value) : e.target.value)}
        className="input"
      />
    </Field>
  );
}

function Field({
  label,
  required,
  help,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required && <span className="text-[rgb(var(--danger))]"> *</span>}
      </span>
      {children}
      {help && <span className="mt-1 block text-xs text-[rgb(var(--fg-subtle))]">{help}</span>}
      {error && (
        <span className="mt-1 block text-xs font-semibold text-[rgb(var(--danger))]">{error}</span>
      )}
    </label>
  );
}
