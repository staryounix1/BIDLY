import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards against the two classes of failure that each surfaced as the generic
 * `23514` / "This action violates a platform rule." and cost a full debugging
 * cycle to identify:
 *
 *   1. a `wallet_transactions` insert that can carry amount 0 — the DB rejects
 *      it (`CHECK (amount_minor > 0)`), and a zero commission is legitimate
 *      (first job free), so the insert must be skipped, not attempted;
 *   2. an offers accept that jumps straight to PROVIDER_SELECTED, which the
 *      request transition trigger forbids.
 *
 * These read source as text: cheap, no database, and they fail loudly the
 * moment someone reintroduces the pattern.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = walk(join(__dirname, '..')).map((f) => ({
  file: f,
  text: readFileSync(f, 'utf8'),
}));

/**
 * Every `wallet_transactions` insert must be paired with a positive-amount
 * guard, declared either in the surrounding block or by a helper the insert
 * delegates to. Rather than guess block boundaries from text distance, we
 * require the guard to appear in the same function: find the enclosing
 * `async (...) => {` / `function` boundary by scanning back for the last
 * top-level-looking `async` keyword before the insert.
 */
function enclosingRegion(text: string, at: number): string {
  const before = text.slice(0, at);
  // Walk back through blank-line-separated paragraphs until we hit a likely
  // function or block opener, or 120 lines.
  const lines = before.split('\n');
  const start = Math.max(0, lines.length - 120);
  return lines.slice(start).join('\n');
}

describe('wallet ledger invariants', () => {
  it('never inserts a wallet_transaction without a positive-amount guard', () => {
    const offenders: string[] = [];
    for (const { file, text } of SOURCES) {
      const ms = [...text.matchAll(/insert into wallet_transactions/gi)];
      for (const m of ms) {
        const region = enclosingRegion(text, m.index ?? 0);
        const guarded =
          // inline or nearby positivity test on the amount/value
          /\b\w*(amount|minor|commission|delta|price|balance|credit|clawback)\w*\s*>\s*0\b/i.test(region) ||
          // explicit zero/invalid rejection
          /\bif\s*\(\s*!?\s*\w+\s*(<=|<|===|==)\s*0\s*\)\s*(return|throw|\{)/i.test(region) ||
          // schema-enforced positive amount
          /amountMinor:\s*\{[^}]*minimum:\s*1/i.test(region) ||
          // a delegating helper that early-returns on the zero case
          /amountMinor\s*<=\s*0\s*\)\s*return/i.test(region);
        if (!guarded) {
          offenders.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
          break;
        }
      }
    }
    expect(
      offenders,
      `wallet_transactions insert without a positive-amount guard:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the offers accept path steps through the legal states before PROVIDER_SELECTED', () => {
    const accept = SOURCES.find((s) => s.file.endsWith('offers/offers.routes.ts'));
    expect(accept, 'offers.routes.ts must exist').toBeTruthy();
    const text = accept!.text;
    const matching = text.indexOf(`status = 'MATCHING'`);
    const receiving = text.indexOf(`status = 'RECEIVING_OFFERS'`);
    const selected = text.indexOf(`status = 'PROVIDER_SELECTED'`);
    expect(matching, 'accept must step PUBLISHED -> MATCHING').toBeGreaterThan(-1);
    expect(receiving, 'accept must step -> RECEIVING_OFFERS').toBeGreaterThan(-1);
    expect(matching, 'MATCHING must precede PROVIDER_SELECTED').toBeLessThan(selected);
    expect(receiving, 'RECEIVING_OFFERS must precede PROVIDER_SELECTED').toBeLessThan(selected);
  });
});
