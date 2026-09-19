import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { env } from '@bidly/config';

/**
 * Password hashing.
 *
 * Argon2id with parameters from the environment. The full encoded string
 * (`$argon2id$v=19$m=...`) is stored — it carries the parameters, so they can
 * be raised later without invalidating existing hashes.
 */

function options(): argon2.Options {
  return {
    type: argon2.argon2id,
    memoryCost: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  };
}

/** Minimum acceptable password policy, enforced server-side. */
export const PASSWORD_MIN_LENGTH = 8;

export interface PasswordPolicyResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Password policy: length, and at least two character classes. Deliberately
 * not so strict that it pushes users toward predictable patterns.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const reasons: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    reasons.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > 128) {
    reasons.push('Password must be at most 128 characters.');
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) {
    reasons.push('Password must include at least two of: lowercase, uppercase, digits, symbols.');
  }
  if (/(.)\1{3,}/.test(password)) {
    reasons.push('Password must not repeat the same character many times.');
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * An in-process cache of fake hashes used to equalise timing on the
 * "user not found" path, so login failures cannot enumerate accounts.
 */
let dummyHash: string | null = null;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, options());
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Constant-ish time verification for missing users. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  if (!dummyHash) dummyHash = await hashPassword(randomUUID());
  await argon2.verify(dummyHash, password).catch(() => false);
  return false;
}

export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, options());
  } catch {
    return true;
  }
}
