import { randomUUID, randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { env } from '@bidly/config';

/**
 * Password hashing.
 *
 * Argon2id with parameters from the environment. The full encoded string
 * (`$argon2id$v=19$m=...`) is stored — it carries the parameters, so they can
 * be raised later without invalidating existing hashes.
 *
 * Implemented with `hash-wasm` (WebAssembly) rather than the native `argon2`
 * addon: the WASM build runs everywhere Node runs, including platforms with no
 * prebuilt native binary (Termux/Android, some ARM hosts).
 */

interface Argon2Params {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

function params(): Argon2Params {
  return {
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

/**
 * Encode raw Argon2id output as a standard PHC string so existing hashes
 * (produced by the native `argon2` package) verify identically.
 */
function toPhc(rawHex: string, salt: Uint8Array, p: Argon2Params): string {
  const saltB64 = Buffer.from(salt).toString('base64').replace(/=+$/, '');
  const hashB64 = Buffer.from(rawHex, 'hex').toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${p.memoryCost},t=${p.timeCost},p=${p.parallelism}$${saltB64}$${hashB64}`;
}

export async function hashPassword(password: string): Promise<string> {
  const p = params();
  const salt = randomBytes(16);
  const raw = await argon2id({
    password,
    salt,
    parallelism: p.parallelism,
    memorySize: p.memoryCost,
    iterations: p.timeCost,
    hashLength: 32,
    outputType: 'hex',
  });
  return toPhc(raw, salt, p);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}

/** Constant-ish time verification for missing users. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  if (!dummyHash) dummyHash = await hashPassword(randomUUID());
  await argon2Verify({ password, hash: dummyHash }).catch(() => false);
  return false;
}

/**
 * True when the stored hash was produced with weaker parameters than the
 * current configuration, so it should be re-hashed on the next login.
 */
export function needsRehash(hash: string): boolean {
  try {
    const m = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
    if (!m) return true;
    const p = params();
    return Number(m[1]) < p.memoryCost || Number(m[2]) < p.timeCost || Number(m[3]) < p.parallelism;
  } catch {
    return true;
  }
}
