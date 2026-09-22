'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import {
  catalogApi,
  localized,
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

/**
 * Load the compose form for whatever the URL named.
 *
 * `?service=` may be an offerable service (`wall-plastering`) or one of the
 * home screen's crafts (`plasterer`). The service slug is tried first, and only
 * a 404 falls through to the catalogue to find the craft's first service — a
 * genuine server error must still surface rather than being swallowed.
 */
async function loadServiceForm(slug: string) {
  try {
    return catalogApi.serviceForm(slug);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
  }
  const { categories } = await catalogApi.tree();
  const sub = categories
    .flatMap((c) => c.subcategories)
    .find((s) => s.slug === slug);
  const first = sub?.services?.[0];
  if (!first) throw new ApiError(404, null, 'Service not found');
  return catalogApi.serviceForm(first.slug);
}

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

/**
 * Fill the service's *required* custom answers from what the customer already
 * provided, so a request can be sent from the map-and-tray screen alone.
 *
 * The compose tray deliberately stops at the send button; everything else about
 * the job travels to the craftsman in chat. But the API hard-rejects a request
 * whose required `service_fields` are empty, so leaving them blank would make
 * those services impossible to order. Only required, still-empty fields are
 * touched, and each is filled with a value of the right *kind*:
 *
 *   SELECT   — one of the field's own option values (a free string is rejected)
 *   DATETIME — now, since no schedule was collected
 *   NUMBER   — its own minimum, else zero
 *   BOOLEAN  — false
 *   text-ish — the customer's title/description, joined
 *
 * Pure, so the submit handler can call it directly and never race the effect
 * that mirrors it into state.
 */
/**
 * Values for required selects that the API declares without any options. The
 * server accepts these (they mirror the constants sent in the payload), and
 * without them the order is rejected on a question the screen no longer asks.
 */
const SELECT_FALLBACK: Record<string, string> = {
  urgency: 'NORMAL',
};

function seedRequiredAnswers(
  fields: ServiceField[],
  answers: Record<string, unknown>,
  title: string,
  description: string,
): Record<string, unknown> {
  const text = [title, description].map((s) => s.trim()).filter(Boolean).join(' — ');
  const seeded: Record<string, unknown> = {};

  for (const f of fields) {
    if (!f.is_required) continue;
    // ADDRESS is owned by the map and synced from it.
    if (f.type === 'ADDRESS') continue;

    const existing = answers[f.key];
    if (existing !== undefined && existing !== null && existing !== '') continue;

    switch (f.type) {
      case 'SELECT': {
        const options = f.options ?? [];
        const chosen = options.find((o) => o.value === f.default_value) ?? options[0];
        // Some required selects ship with no options at all (the launch
        // service's `urgency` is the live example). `validateServiceAnswers`
        // still rejects an empty required field, so fall back to the value the
        // payload already sends rather than refusing the order.
        seeded[f.key] = chosen ? chosen.value : SELECT_FALLBACK[f.key] ?? '';
        if (seeded[f.key] === '') delete seeded[f.key];
        break;
      }
      case 'MULTISELECT': {
        const options = f.options ?? [];
        const chosen = options.find((o) => o.value === f.default_value) ?? options[0];
        seeded[f.key] = chosen ? [chosen.value] : [];
        break;
      }
      case 'PHONE':
        // Not collected on this screen; any placeholder would be a lie, and the
        // customer is reachable through the account.
        break;
      case 'DATETIME':
      case 'DATE':
        seeded[f.key] = new Date().toISOString();
        break;
      case 'NUMBER': {
        const n = Number(f.min_value ?? 0);
        seeded[f.key] = Number.isFinite(n) ? n : 0;
        break;
      }
      case 'BOOLEAN':
        seeded[f.key] = false;
        break;
      case 'TEXT':
      case 'TEXTAREA':
        if (text) seeded[f.key] = f.type === 'TEXTAREA' ? text : text.slice(0, 120);
        break;
      default:
        // PHOTO, VIDEO, LOCATION and anything the API adds later are not
        // answerable from this screen. Seeding the description into them would
        // send garbage, so leave them for the server to judge.
        break;
    }
  }
  return seeded;
}

/**
 * A human-readable stand-in for a picked point whose street address could not
 * be resolved. The API requires a non-empty `line1`, and the exact coordinates
 * travel alongside it, so this is a label rather than a fallback location.
 */
function coordLabel(point: { lat: number; lng: number } | null): string {
  if (!point) return '';
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
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
  // Urgency is no longer picked on this screen; NORMAL keeps the request in the
  // ordinary matching queue. The service's own `urgency` question is seeded
  // separately, since the API requires it.
  const urgency = 'NORMAL';
  const [price, setPrice] = useState(0);

  // Scheduling, item count and "I need a helper" are no longer collected on this
  // screen: the tray stops at the send button and the rest of the brief travels
  // to the craftsman in chat. These remain as fixed values only so the payload
  // keeps the shape the API expects.
  const scheduledAt = '';
  const itemCount = '';
  const requiresHelper = false;

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
          /**
           * The home screen's craft tiles link to a *subcategory* slug
           * (`plasterer`), because a craft is not a single offerable service —
           * a plasterer does walls, ceilings and decorative work. The compose
           * API only knows service slugs, so a subcategory path is resolved to
           * that craft's first service instead of 404ing with "Service not
           * found". A real service slug still wins, so nothing changes for the
           * links that already worked.
           */
          const form = await loadServiceForm(serviceSlug);
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
    // Fall back to the coordinate label for the same reason submit does: the
    // address comes from reverse-geocoding, which is slow and may return
    // nothing, and a required ADDRESS answer left empty blocks the send.
    const point = service?.requires_location ? pickupPoint : destinationPoint;
    const line1 = (service?.requires_location ? pickup : destination).line1.trim();
    const value = line1 || coordLabel(point);
    if (!value) return;
    setAnswers((prev) =>
      prev[addressFieldKey] === value ? prev : { ...prev, [addressFieldKey]: value },
    );
  }, [
    addressFieldKey,
    service?.requires_location,
    pickup,
    destination,
    pickupPoint,
    destinationPoint,
  ]);

  // The compose tray no longer asks the service's custom questions: the map
  // supplies the location and everything else travels to the craftsman in the
  // chat once they engage. The API still rejects a request whose *required*
  // service fields are empty, so fill those from what the customer already
  // gave us rather than blocking the send button on a form they never see.
  // Optional fields are always left alone.
  const seededRequiredFields = useMemo(
    () => seedRequiredAnswers(fields, answers, title, description),
    [fields, answers, title, description],
  );

  useEffect(() => {
    if (Object.keys(seededRequiredFields).length === 0) return;
    setAnswers((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [k, v] of Object.entries(seededRequiredFields)) {
        if (next[k] === v) continue;
        next[k] = v;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [seededRequiredFields]);

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
    //
    // The location is now given by tapping the map, not typed, so a picked
    // point satisfies it on its own. Requiring a reverse-geocoded street here
    // would send the customer in a circle: Nominatim is slow, rate-limited and
    // may return nothing for a valid point, and there is no text field left to
    // fill in by hand.
    const nextErrors: Record<string, string> = {};
    const hasPickup = Boolean(pickupPoint) || pickup.line1.trim().length > 0;
    const hasDestination = Boolean(destinationPoint) || destination.line1.trim().length > 0;
    if (service.requires_location && !hasPickup) nextErrors.pickup = t('compose.needPickup');
    if (service.requires_destination && !hasDestination) {
      nextErrors.destination = t('compose.needDestination');
    }
    if (price <= 0) nextErrors.price = t('request.answerRequired');
    if (Object.keys(nextErrors).length > 0) {
      setFormErrors(nextErrors);
      // Name the missing thing: "fill the required fields" on a screen with no
      // empty fields reads as a bug.
      setSubmitError(
        nextErrors.pickup ?? nextErrors.destination ?? t('request.answerRequired'),
      );
      return;
    }
    setFormErrors({});

    // The service's required questions are not shown on this screen, so derive
    // their answers here instead of trusting the effect to have run first.
    const finalAnswers = { ...answers, ...seedRequiredAnswers(fields, answers, title, description) };

    const fieldErrors = validateServiceAnswers(fields, finalAnswers);
    if (Object.keys(fieldErrors).length > 0) {
      setAnswerErrors(fieldErrors);
      setSubmitError(t('request.answerRequired'));
      return;
    }
    setAnswerErrors({});

    const priceMinor = Math.round(price * 100);
    // The API's location schema requires a non-empty `line1`, but the address
    // itself now comes from reverse-geocoding, which can be slow or return
    // nothing. Fall back to the coordinate label so a picked point is always
    // submittable; the craftsman still receives the exact lat/lng either way.
    const pickupLine1 = pickup.line1.trim() || coordLabel(pickupPoint);
    const destinationLine1 = destination.line1.trim() || coordLabel(destinationPoint);

    const payload = {
      serviceId: service.id,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      answers: finalAnswers,
      budgetMinMinor: priceMinor,
      budgetMaxMinor: priceMinor,
      currency: service.default_currency,
      urgency,
      ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      ...(itemCount ? { itemCount: Number(itemCount) } : {}),
      requiresHelper,
      ...(service.requires_location && (pickupPoint || pickupLine1)
        ? {
            pickup: {
              line1: pickupLine1,
              ...(pickup.district ? { district: pickup.district } : {}),
              ...(pickup.cityId ? { cityId: pickup.cityId } : {}),
              ...(pickupPoint ? { lat: pickupPoint.lat, lng: pickupPoint.lng } : {}),
              ...(pickup.notes ? { notes: pickup.notes } : {}),
            },
          }
        : {}),
      ...(service.requires_destination && (destinationPoint || destinationLine1)
        ? {
            destination: {
              line1: destinationLine1,
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
                setFormErrors((prev) => ({ ...prev, destination: '' }));
              }
            }}
            address={needsLocation ? pickup.line1 : destination.line1}
            onAddressChange={(line1: string) => {
              // The map is the source of truth for where the job is, so the
              // reverse-geocoded address fills `line1` directly instead of
              // asking the customer to retype it in a field below the map.
              if (needsLocation) setPickup((prev) => ({ ...prev, line1 }));
              else setDestination((prev) => ({ ...prev, line1 }));
            }}
            variant="full"
            autoFillAddress
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

        </form>
      </BottomSheet>

      {/* Outside the sheet on purpose: react-modal-sheet transforms its panel,
          which makes any `fixed` child position against the sheet instead of
          the viewport, so an in-sheet alert lands off the bottom of the screen
          on a phone. Page level is the only place it stays visible. */}
      {submitError && (
        <div
          role="alert"
          className="pointer-events-none fixed inset-x-0 bottom-24 z-[1200] px-4"
        >
          <p className="mx-auto max-w-md rounded-xl bg-[rgb(var(--danger))] px-4 py-3 text-center text-sm font-bold text-white shadow-xl">
            {submitError}
          </p>
        </div>
      )}
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
