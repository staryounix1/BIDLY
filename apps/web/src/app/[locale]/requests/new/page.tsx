'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-provider';
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
import { createRequestSchema, validateServiceAnswers } from '@bidly/validation';

/**
 * Dynamic request-creation form.
 *
 * The flow: pick a service (from the URL or the catalogue), the service's
 * `service_fields` are rendered as inputs, plus the pickup/destination blocks
 * the service declares it needs. On submit the request is created as a DRAFT;
 * a successful create offers to publish it, which is what starts matching.
 */
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

  const [service, setService] = useState<(Service & { category_slug: string; subcategory_slug: string }) | null>(null);
  const [fields, setFields] = useState<ServiceField[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState('NORMAL');
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
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

  // Guards against a second submit firing before React re-renders the disabled
  // button — a slow tap on mobile can otherwise create the request twice.
  const inFlight = useRef(false);

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

  const visibleFields = useMemo(
    () =>
      fields.filter((f) => {
        if (!f.depends_on_key) return true;
        const dependency = answers[f.depends_on_key];
        return String(dependency ?? '') === String(f.depends_on_value ?? '');
      }),
    [fields, answers],
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!service) return;
    if (inFlight.current) return;
    setSubmitError(null);

    // Client-side required checks. The API re-validates everything; this only
    // turns obvious mistakes into inline errors before a round-trip.
    const nextErrors: Record<string, string> = {};
    if (service.requires_location && !pickup.line1.trim()) nextErrors.pickup = t('request.answerRequired');
    if (service.requires_destination && !destination.line1.trim()) nextErrors.destination = t('request.answerRequired');
    if (budgetMin && budgetMax && Number(budgetMax) < Number(budgetMin)) {
      nextErrors.budget = t('request.budgetMax');
    }
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

    const payload = {
      serviceId: service.id,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      answers,
      ...(budgetMin ? { budgetMinMinor: Math.round(Number(budgetMin) * 100) } : {}),
      ...(budgetMax ? { budgetMaxMinor: Math.round(Number(budgetMax) * 100) } : {}),
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

  if (loading) return <main className="mx-auto max-w-3xl px-4 py-10 opacity-60">{t('common.loading')}</main>;

  if (!serviceSlug || !service) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-bold">{t('request.newTitle')}</h1>
        <p className="mt-2 opacity-70">{t('catalog.chooseService')}</p>
        {loadError && <p className="mt-4 text-sm text-red-600">{loadError}</p>}
        <ServicePicker cities={cities} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <button onClick={() => router.back()} className="mb-4 text-sm opacity-60 hover:opacity-100">
        ← {t('common.back')}
      </button>
      <h1 className="text-2xl font-bold">{localized(service, locale)}</h1>
      <p className="mt-1 text-sm opacity-70">{t('request.newTitle')}</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-6" noValidate>
        <section className="space-y-4 rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <h2 className="font-semibold">{t('request.detailsTitle')}</h2>

          <Field label={t('request.title')}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} className={inputClass} />
          </Field>

          <Field label={t('request.description')}>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} className={inputClass} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('request.urgency')}>
              <select value={urgency} onChange={(e) => setUrgency(e.target.value)} className={inputClass}>
                {(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).map((u) => (
                  <option key={u} value={u}>
                    {t(`urgency.${u}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('request.scheduledAt')}>
              <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={inputClass} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`${t('request.budgetMin')} (${service.default_currency})`}>
              <input type="number" min="0" step="1" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} className={inputClass} />
            </Field>
            <Field label={`${t('request.budgetMax')} (${service.default_currency})`} error={formErrors.budget}>
              <input type="number" min="0" step="1" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} className={inputClass} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('request.itemCount')}>
              <input type="number" min="0" value={itemCount} onChange={(e) => setItemCount(e.target.value)} className={inputClass} />
            </Field>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={requiresHelper} onChange={(e) => setRequiresHelper(e.target.checked)} />
              {t('request.requiresHelper')}
            </label>
          </div>
        </section>

        {visibleFields.length > 0 && (
          <section className="space-y-4 rounded-2xl border border-black/10 p-5 dark:border-white/15">
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
          </section>
        )}

        {service.requires_location && (
          <section className="space-y-4 rounded-2xl border border-black/10 p-5 dark:border-white/15">
            <h2 className="font-semibold">{t('request.pickup')}</h2>
            <MapPicker
              value={pickupPoint}
              onChange={(p) => {
                setPickupPoint(p);
                setFormErrors((prev) => ({ ...prev, pickup: '' }));
              }}
              address={pickup.line1}
              onAddressChange={(line1) => setPickup((prev) => ({ ...prev, line1 }))}
            />
            <Field label={t('request.line1')} required error={formErrors.pickup}>
              <input value={pickup.line1} onChange={(e) => setPickup({ ...pickup, line1: e.target.value })} className={inputClass} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('request.district')}>
                <input value={pickup.district} onChange={(e) => setPickup({ ...pickup, district: e.target.value })} className={inputClass} />
              </Field>
              <Field label={t('request.city')}>
                <CitySelect cities={cities} locale={locale} value={pickup.cityId} onChange={(v) => setPickup({ ...pickup, cityId: v })} />
              </Field>
            </div>
            <Field label={t('request.notes')}>
              <input value={pickup.notes} onChange={(e) => setPickup({ ...pickup, notes: e.target.value })} className={inputClass} />
            </Field>
          </section>
        )}

        {service.requires_destination && (
          <section className="space-y-4 rounded-2xl border border-black/10 p-5 dark:border-white/15">
            <h2 className="font-semibold">{t('request.destination')}</h2>
            <MapPicker
              value={destinationPoint}
              onChange={setDestinationPoint}
              address={destination.line1}
              onAddressChange={(line1) => setDestination((prev) => ({ ...prev, line1 }))}
              height={220}
            />
            <Field label={t('request.line1')} required error={formErrors.destination}>
              <input value={destination.line1} onChange={(e) => setDestination({ ...destination, line1: e.target.value })} className={inputClass} />
            </Field>
            <Field label={t('request.city')}>
              <CitySelect cities={cities} locale={locale} value={destination.cityId} onChange={(v) => setDestination({ ...destination, cityId: v })} />
            </Field>
            <Field label={t('request.notes')}>
              <input value={destination.notes} onChange={(e) => setDestination({ ...destination, notes: e.target.value })} className={inputClass} />
            </Field>
          </section>
        )}

        {submitError && (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
        >
          {submitting ? t('request.submitting') : t('request.submit')}
        </button>
      </form>
    </main>
  );
}

function ServicePicker({ cities }: { cities: City[] }) {
  const { t, locale } = useI18n();
  const [categories, setCategories] = useState<Awaited<ReturnType<typeof catalogApi.tree>>['categories']>([]);
  void cities;

  useEffect(() => {
    catalogApi.tree().then((d) => setCategories(d.categories)).catch(() => setCategories([]));
  }, []);

  return (
    <div className="mt-6 space-y-6">
      {categories.map((cat) => (
        <section key={cat.id}>
          <h2 className="font-semibold">{localized(cat, locale)}</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {cat.subcategories.flatMap((sub) => sub.services).map((s) => (
              <a
                key={s.id}
                href={`/${locale}/requests/new?service=${s.slug}`}
                className="rounded-lg border border-black/10 px-3 py-2 text-sm hover:border-slate-900 dark:border-white/15 dark:hover:border-white"
              >
                {localized(s, locale)}
              </a>
            ))}
          </div>
        </section>
      ))}
      {categories.length === 0 && <p className="text-sm opacity-60">{t('common.loading')}</p>}
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
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      <option value="">{t('common.none')}</option>
      {cities.map((c) => (
        <option key={c.id} value={c.id}>
          {localized(c as unknown as { name_en: string; name_fr: string | null; name_ar: string | null }, locale)}
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
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }

  if (field.type === 'SELECT') {
    return (
      <Field label={label} required={field.is_required} help={help} error={error}>
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={inputClass}>
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
                onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
                className={`rounded-full border px-3 py-1 text-xs ${
                  on ? 'border-slate-900 font-semibold dark:border-white' : 'border-black/15 dark:border-white/20'
                }`}
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
    field.type === 'NUMBER' ? 'number' : field.type === 'DATE' ? 'date' : field.type === 'DATETIME' ? 'datetime-local' : field.type === 'PHONE' ? 'tel' : 'text';

  if (field.type === 'TEXTAREA' || field.type === 'ADDRESS') {
    return (
      <Field label={label} required={field.is_required} help={help} error={error}>
        <textarea
          value={String(value ?? '')}
          placeholder={placeholder}
          maxLength={field.max_length ?? undefined}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={inputClass}
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
        className={inputClass}
      />
    </Field>
  );
}

const inputClass =
  'w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm font-normal outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white';

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
    <label className="flex flex-col gap-1 text-sm font-medium">
      <span>
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
      {help && <span className="text-xs font-normal opacity-60">{help}</span>}
      {error && <span className="text-xs font-normal text-red-600">{error}</span>}
    </label>
  );
}
