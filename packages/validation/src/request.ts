import { z } from 'zod';

/**
 * Request (and service) validation.
 *
 * These mirror the server-side rules in `modules/requests/requests.routes.ts`
 * so the customer form rejects the same data the API would. The API always
 * re-validates; the client copy is for immediate, friendly feedback.
 */

export const requestUrgencySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export const requestLocationSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  district: z.string().trim().max(100).optional(),
  cityId: z.string().uuid().optional(),
  cityName: z.string().trim().max(100).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  notes: z.string().trim().max(300).optional(),
});

export const requestDestinationSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  cityId: z.string().uuid().optional(),
  cityName: z.string().trim().max(100).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  notes: z.string().trim().max(300).optional(),
});

export const createRequestSchema = z
  .object({
    serviceId: z.string().uuid('Choose a service.'),
    title: z.string().trim().max(140).optional(),
    description: z.string().trim().max(2000).optional(),
    answers: z.record(z.unknown()).optional(),
    budgetMinMinor: z.number().int().nonnegative().optional(),
    budgetMaxMinor: z.number().int().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    urgency: requestUrgencySchema.optional(),
    scheduledAt: z.string().optional(),
    scheduledFlexible: z.boolean().optional(),
    itemCount: z.number().int().nonnegative().optional(),
    requiresHelper: z.boolean().optional(),
    pickup: requestLocationSchema.optional(),
    destination: requestDestinationSchema.optional(),
    mediaUrls: z.array(z.string().url().max(2048)).max(10).optional(),
  })
  .refine(
    (v) =>
      v.budgetMinMinor == null ||
      v.budgetMaxMinor == null ||
      v.budgetMaxMinor >= v.budgetMinMinor,
    { message: 'The maximum budget must be at least the minimum.', path: ['budgetMaxMinor'] },
  );

export const cancelRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const listRequestsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type RequestLocationInput = z.infer<typeof requestLocationSchema>;

/**
 * Validate a dynamic service-field answer map against field definitions.
 * Returns a map of field key -> error message; empty means valid.
 */
export interface ServiceFieldDef {
  key: string;
  type: string;
  is_required: boolean;
  min_value?: number | string | null;
  max_value?: number | string | null;
  min_length?: number | null;
  max_length?: number | null;
  regex?: string | null;
}

export function validateServiceAnswers(
  fields: ServiceFieldDef[],
  answers: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const value = answers[field.key];
    const isEmpty = value === undefined || value === null || value === '';

    if (field.is_required && isEmpty) {
      errors[field.key] = 'This field is required.';
      continue;
    }
    if (isEmpty) continue;

    if (field.type === 'NUMBER') {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) {
        errors[field.key] = 'Enter a valid number.';
      } else if (field.min_value != null && num < Number(field.min_value)) {
        errors[field.key] = `Must be at least ${field.min_value}.`;
      } else if (field.max_value != null && num > Number(field.max_value)) {
        errors[field.key] = `Must be at most ${field.max_value}.`;
      }
    }

    if (typeof value === 'string') {
      if (field.min_length != null && value.length < field.min_length) {
        errors[field.key] = `Use at least ${field.min_length} characters.`;
      } else if (field.max_length != null && value.length > field.max_length) {
        errors[field.key] = `Use at most ${field.max_length} characters.`;
      } else if (field.regex) {
        try {
          if (!new RegExp(field.regex).test(value)) errors[field.key] = 'The value has an invalid format.';
        } catch {
          // A malformed regex definition is the platform's problem, not the
          // user's: ignore it rather than block a valid submission.
        }
      }
    }
  }

  return errors;
}
