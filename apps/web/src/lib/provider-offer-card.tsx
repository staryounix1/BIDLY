'use client';

import { useI18n } from '@/lib/i18n-provider';
import { Avatar, Price, Stars, toNumber } from '@/lib/ui';
import { CategoryIcon } from '@/lib/icons';
import type { RequestDetail } from '@/lib/requests-api';

export type OfferRow = RequestDetail['offers'][number];

/**
 * The decision card for one incoming offer.
 *
 * A customer with three offers on screen should not have to read three cards
 * and hunt for buttons: tapping an offer opens one focused panel that states
 * who the craftsman is — photo, name, craft, city, experience, rating — and
 * what they are asking, with accept and decline where the thumb already is.
 *
 * `busy` disables both actions so a double tap cannot fire two transitions.
 */
export interface ProviderOfferCardProps {
  offer: OfferRow;
  locale: string;
  /** The request this offer belongs to, shown as the context line. */
  requestCode?: string | null;
  busy?: boolean;
  onAccept: () => void;
  onReject: () => void;
  onClose: () => void;
}

/** Pick the localised value with the same precedence the rest of the app uses. */
function pick(locale: string, ar?: string | null, en?: string | null, fr?: string | null): string | null {
  const order = locale === 'ar' ? [ar, en, fr] : locale === 'fr' ? [fr, en, ar] : [en, fr, ar];
  for (const v of order) if (v) return v;
  return null;
}

export function ProviderOfferCard({
  offer,
  locale,
  requestCode,
  busy = false,
  onAccept,
  onReject,
  onClose,
}: ProviderOfferCardProps) {
  const { t } = useI18n();

  const city = pick(locale, offer.city_name_ar, offer.city_name_en, offer.city_name_fr);
  const craft = pick(locale, offer.craft_name_ar, offer.craft_name_en, offer.craft_name_fr);
  const years = toNumber(offer.experience_years);
  const etaMinutes = toNumber(offer.eta_minutes);

  return (
    <div
      className="offer-modal fixed inset-0 z-[70] flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="offer-modal-panel sheet sheet-up w-full max-w-md p-0 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle sm:hidden" />

        {/* Identity: the whole point of this panel. */}
        <div className="offer-modal-head">
          <Avatar name={offer.provider_name} src={offer.provider_avatar} size={72} />

          <div className="offer-modal-id">
            <p className="offer-modal-name">{offer.provider_name}</p>

            <div className="offer-modal-meta">
              <Stars value={offer.rating_avg} count={offer.completed_jobs} />
            </div>

            <ul className="offer-modal-facts">
              {craft && (
                <li>
                  <CategoryIcon name="wrench" size={14} />
                  <span>{craft}</span>
                </li>
              )}
              {city && (
                <li>
                  <CategoryIcon name="pin" size={14} />
                  <span>{city}</span>
                </li>
              )}
              {years != null && years > 0 && (
                <li>
                  <CategoryIcon name="star" size={14} />
                  <span>{t('offerCard.experience', { years })}</span>
                </li>
              )}
              {etaMinutes != null && (
                <li>
                  <CategoryIcon name="clock" size={14} />
                  <span>{t('offerCard.eta', { minutes: etaMinutes })}</span>
                </li>
              )}
            </ul>
          </div>
        </div>

        {offer.bio && <p className="offer-modal-bio">{offer.bio}</p>}

        {offer.message && (
          <p className="offer-modal-quote">
            <CategoryIcon name="chat" size={14} />
            {offer.message}
          </p>
        )}

        {/* The number being negotiated. */}
        <div className="offer-modal-price">
          <span className="offer-modal-price-label">{t('offerCard.asked')}</span>
          <Price minor={offer.price_minor} currency={offer.currency} size="lg" />
          {requestCode && <span className="offer-modal-code">{requestCode}</span>}
        </div>

        {/* Decision. */}
        <div className="offer-modal-actions">
          <button
            type="button"
            className="btn btn-primary flex-1"
            disabled={busy}
            onClick={onAccept}
          >
            <CategoryIcon name="check" size={18} />
            {t('offerCard.accept')}
          </button>
          <button
            type="button"
            className="btn btn-secondary flex-1"
            disabled={busy}
            onClick={onReject}
          >
            <CategoryIcon name="x" size={18} />
            {t('offerCard.reject')}
          </button>
        </div>

        <button type="button" className="offer-modal-cancel" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
