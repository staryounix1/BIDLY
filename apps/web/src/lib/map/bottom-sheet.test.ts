import { describe, expect, it } from 'vitest';
import {
  detentPointIndex,
  detentSnapIndex,
  detentSnapPoints,
  DETENTS,
} from './bottom-sheet';

/**
 * react-modal-sheet positions the sheet with
 * `translateY = (1 - point) * sheetHeight` and prepends its own `0` (closed)
 * point, so a snap `point` is the share of the sheet left visible and its
 * indices are ours shifted by one.
 *
 * These tests model that geometry directly and assert the *rendered position*
 * of each detent. Asserting only the array shape let three separate mistakes
 * through (inverted direction, a seeded endpoint, and the index shift), because
 * each produced a plausible-looking array.
 */

const SHEET_HEIGHT = 534;

/** Mirror of the library's positioning maths. */
const translateYFor = (point: number, height = SHEET_HEIGHT) => (1 - point) * height;

/** Share of the sheet left visible when a detent is active. */
const visibleShare = (detent: 'peek' | 'half' | 'full', points: number[]) =>
  points[detentPointIndex(detent)] as number;

describe('detentSnapPoints', () => {
  const HEIGHTS = { peek: 0.4, half: 0.66, full: 0.92 };

  it('shows the share of the screen each detent is named for', () => {
    const points = detentSnapPoints(HEIGHTS);
    expect(visibleShare('peek', points)).toBeCloseTo(0.4, 5);
    expect(visibleShare('half', points)).toBeCloseTo(0.66, 5);
    expect(visibleShare('full', points)).toBeCloseTo(0.92, 5);
  });

  it('renders peek as a low tray and full as nearly the whole screen', () => {
    const points = detentSnapPoints(HEIGHTS);
    const peekY = translateYFor(points[detentPointIndex('peek')] as number);
    const fullY = translateYFor(points[detentPointIndex('full')] as number);
    // peek leaves roughly 40% of the sheet on screen, so it sits lowest.
    expect(peekY).toBeCloseTo(SHEET_HEIGHT * 0.6, 1);
    expect(fullY).toBeCloseTo(SHEET_HEIGHT * 0.08, 1);
    // Larger translateY means pushed further down the screen.
    expect(peekY).toBeGreaterThan(fullY);
  });

  it('is strictly ascending, which react-modal-sheet validates', () => {
    const points = detentSnapPoints();
    for (let i = 1; i < points.length; i++) {
      expect(points[i] as number).toBeGreaterThan(points[i - 1] as number);
    }
  });

  it('exposes exactly one point per detent', () => {
    expect(detentSnapPoints()).toHaveLength(DETENTS.length);
  });

  it('orders a taller detent as strictly more visible than a shorter one', () => {
    const points = detentSnapPoints();
    expect(visibleShare('full', points)).toBeGreaterThan(visibleShare('half', points));
    expect(visibleShare('half', points)).toBeGreaterThan(visibleShare('peek', points));
  });

  it('keeps every point inside the open interval, since 0 and 1 are the endpoints', () => {
    for (const point of detentSnapPoints()) {
      expect(point).toBeGreaterThan(0);
      expect(point).toBeLessThan(1);
    }
  });
});

describe('detentPointIndex', () => {
  it('maps each detent to its own slot in our array', () => {
    DETENTS.forEach((detent, i) => {
      expect(detentPointIndex(detent)).toBe(i);
    });
  });

  it('returns -1 for an unknown detent rather than a wrong slot', () => {
    expect(detentPointIndex('nope' as never)).toBe(-1);
  });
});

describe('detentSnapIndex', () => {
  it('is offset by one for the closed point the library prepends', () => {
    DETENTS.forEach((detent, i) => {
      expect(detentSnapIndex(detent)).toBe(i + 1);
    });
  });

  it('never returns 0, which is the library closed point, not a detent', () => {
    for (const detent of DETENTS) {
      expect(detentSnapIndex(detent)).toBeGreaterThan(0);
    }
  });

  it('round-trips through the shift used by onSnap', () => {
    // `onSnap` receives detentSnapIndex(d); DETENTS[index - 1] must give d back.
    for (const detent of DETENTS) {
      expect(DETENTS[detentSnapIndex(detent) - 1]).toBe(detent);
    }
  });

  it('selects the snap point whose translateY matches the detent height', () => {
    const points = detentSnapPoints();
    // What the library will actually snap to, including its prepended point.
    const libraryPoints = [0, ...points, 1];
    for (const detent of DETENTS) {
      const active = libraryPoints[detentSnapIndex(detent)] as number;
      expect(active).toBeCloseTo(points[detentPointIndex(detent)] as number, 10);
    }
  });
});
