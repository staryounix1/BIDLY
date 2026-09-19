import { describe, expect, it } from 'vitest';
import { cancelRequestSchema, createRequestSchema, validateServiceAnswers } from './request.js';

const SERVICE_ID = '11111111-1111-1111-1111-111111111111';

describe('request validation', () => {
  it('accepts a minimal valid request', () => {
    const result = createRequestSchema.safeParse({ serviceId: SERVICE_ID });
    expect(result.success).toBe(true);
  });

  it('requires a uuid service id', () => {
    expect(createRequestSchema.safeParse({ serviceId: 'not-a-uuid' }).success).toBe(false);
    expect(createRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a budget where max is below min', () => {
    const result = createRequestSchema.safeParse({
      serviceId: SERVICE_ID,
      budgetMinMinor: 5000,
      budgetMaxMinor: 1000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    const result = createRequestSchema.safeParse({
      serviceId: SERVICE_ID,
      pickup: { line1: 'A', lat: 200, lng: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional cancel reason', () => {
    expect(cancelRequestSchema.safeParse({}).success).toBe(true);
    expect(cancelRequestSchema.safeParse({ reason: 'changed my mind' }).success).toBe(true);
  });
});

describe('dynamic service answer validation', () => {
  const fields = [
    { key: 'details', type: 'TEXTAREA', is_required: true },
    { key: 'budget_hint', type: 'NUMBER', is_required: false, min_value: 10, max_value: 100 },
    { key: 'email', type: 'TEXT', is_required: false, regex: '^[^@]+@[^@]+$' },
  ];

  it('flags missing required fields', () => {
    expect(validateServiceAnswers(fields, {})).toHaveProperty('details');
  });

  it('enforces numeric bounds', () => {
    expect(validateServiceAnswers(fields, { details: 'x', budget_hint: 5 })).toHaveProperty('budget_hint');
    expect(validateServiceAnswers(fields, { details: 'x', budget_hint: 500 })).toHaveProperty('budget_hint');
    expect(validateServiceAnswers(fields, { details: 'x', budget_hint: 50 })).toEqual({});
  });

  it('enforces regex patterns and ignores malformed ones', () => {
    expect(validateServiceAnswers(fields, { details: 'x', email: 'nope' })).toHaveProperty('email');
    expect(validateServiceAnswers(fields, { details: 'x', email: 'a@b' })).toEqual({});
  });
});
