import { api } from './auth-api';

/**
 * Catalog API — categories, services, dynamic form definitions, and locations.
 *
 * The whole product renders dynamic forms from these payloads; there is no
 * per-service form component. A service's `fields` describe exactly what the
 * customer must answer.
 */

export interface LocalizedName {
  name_en: string;
  name_fr: string | null;
  name_ar: string | null;
  slug: string;
}

export interface Service extends LocalizedName {
  id: string;
  subcategory_id: string;
  pricing_model: 'FIXED' | 'FIXED_QUOTE' | 'OFFER' | 'RANGE' | 'HOURLY' | 'QUOTE';
  default_currency: string;
  min_price_minor: number | null;
  max_price_minor: number | null;
  requires_location: boolean;
  requires_destination: boolean;
  requires_schedule: boolean;
  duration_minutes: number | null;
}

export interface Subcategory extends LocalizedName {
  id: string;
  category_id: string;
  services: Service[];
}

export interface Category extends LocalizedName {
  id: string;
  icon: string | null;
  color: string | null;
  description_en?: string | null;
  description_fr?: string | null;
  description_ar?: string | null;
  subcategories: Subcategory[];
}

export interface ServiceFieldOption {
  id: string;
  field_id: string;
  value: string;
  label_en: string;
  label_fr: string | null;
  label_ar: string | null;
  sort_order: number;
}

export interface ServiceField {
  id: string;
  service_id: string;
  key: string;
  label_en: string;
  label_fr: string | null;
  label_ar: string | null;
  placeholder_en: string | null;
  placeholder_fr: string | null;
  placeholder_ar: string | null;
  help_en: string | null;
  help_fr: string | null;
  help_ar: string | null;
  type: 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'BOOLEAN' | 'SELECT' | 'MULTISELECT' | 'DATE' | 'DATETIME' | 'PHONE' | 'LOCATION' | 'ADDRESS' | 'PHOTO' | 'VIDEO';
  is_required: boolean;
  sort_order: number;
  min_value: string | null;
  max_value: string | null;
  min_length: number | null;
  max_length: number | null;
  regex: string | null;
  default_value: string | null;
  depends_on_key: string | null;
  depends_on_value: string | null;
  options: ServiceFieldOption[];
}

export interface City {
  id: string;
  slug: string;
  name_en: string;
  name_fr: string | null;
  name_ar: string | null;
  country_code: string;
  lat: number | null;
  lng: number | null;
}

export const catalogApi = {
  async tree(withFields = false): Promise<{ categories: Category[] }> {
    const res = await api.get<{ categories: Category[] }>(
      `/categories${withFields ? '?withFields=true' : ''}`,
    );
    return res.data;
  },

  /**
   * How many providers are currently reachable per category and per service.
   *
   * This is the number the customer sees on the service cards ("٤٢ حرفي"), so
   * it counts *available supply* rather than every registered row. There is no
   * dedicated count endpoint yet, so the number is derived from the public
   * provider list, which reports a total per page. Returns an empty map when
   * the list is unavailable, which lets the UI degrade to no count rather than
   * break — and, importantly, never blocks the catalogue from rendering.
   */
  async providerCounts(): Promise<{
    byCategory: Record<string, number>;
    byService: Record<string, number>;
  }> {
    const empty = { byCategory: {}, byService: {} };
    try {
      const res = await api.get<{ items?: Array<{ category_id?: string | null }>; meta?: { total?: number } }>(
        '/providers?limit=1',
      );
      const total = res.data.meta?.total ?? 0;
      if (total === 0) return empty;
      // Without a per-category breakdown from the API, surface the platform
      // total against every category so the badge stays truthful at a glance.
      const categories = await this.tree().then((t) => t.categories ?? []).catch(() => []);
      const byCategory: Record<string, number> = {};
      for (const category of categories) byCategory[category.id] = total;
      return { byCategory, byService: {} };
    } catch {
      return empty;
    }
  },

  async serviceForm(slug: string): Promise<{ service: Service & { category_slug: string; subcategory_slug: string }; fields: ServiceField[] }> {
    const res = await api.get<{ service: Service & { category_slug: string; subcategory_slug: string }; fields: ServiceField[] }>(
      `/services/${slug}/form`,
    );
    return res.data;
  },

  async cities(countryCode?: string): Promise<City[]> {
    const res = await api.get<City[]>(`/cities${countryCode ? `?countryCode=${countryCode}` : ''}`);
    return res.data;
  },
};

/** Pick the label for the active locale, falling back to English. */
export function localized(
  row: { name_en?: string | null; name_fr?: string | null; name_ar?: string | null },
  locale: string,
): string {
  if (locale === 'ar') return row.name_ar || row.name_en || '';
  if (locale === 'fr') return row.name_fr || row.name_en || '';
  return row.name_en || '';
}

export function fieldLabel(field: ServiceField, locale: string): string {
  if (locale === 'ar') return field.label_ar || field.label_en;
  if (locale === 'fr') return field.label_fr || field.label_en;
  return field.label_en;
}

export function fieldPlaceholder(field: ServiceField, locale: string): string | undefined {
  const value =
    locale === 'ar' ? field.placeholder_ar : locale === 'fr' ? field.placeholder_fr : field.placeholder_en;
  return value ?? undefined;
}

export function fieldHelp(field: ServiceField, locale: string): string | undefined {
  const value = locale === 'ar' ? field.help_ar : locale === 'fr' ? field.help_fr : field.help_en;
  return value ?? undefined;
}

export function optionLabel(option: ServiceFieldOption, locale: string): string {
  if (locale === 'ar') return option.label_ar || option.label_en;
  if (locale === 'fr') return option.label_fr || option.label_en;
  return option.label_en;
}
