import { describe, expect, it } from 'vitest';
import {
  detentPointIndex,
  detentSnapIndex,
  detentSnapPoints,
  DETENTS,
} from './bottom-sheet';

/**
 * react-modal-sheet turns a snap point into `translateY = (1 - point) * height`
 * and prepends its own `0` (closed) point, so its indices are ours shifted by
 * one. These tests pin the on-screen geometry and that offset, which are the two
 * things that were easy to get backwards.
 */
describe('detentSnapPoints', () => {
  const HEIGHTS = { peek: 0.4, half: 0.66, full: 0.92 };

  /** Share of the sheet that stays visible for a given detent. */
  const visibleShare = (detent: 'peek' | 'half' | 'full', points: number[]) =>
    1 - (points[detentPointIndex(detent)] as number);

  it('makes each detent cover the share of the screen it is named for', () => {
    const points = detentSnapPoints(HEIGHTS);
    expect(visibleShare('peek', points)).toBeCloseTo(0.4, 5);
    expect(visibleShare('half', points)).toBeCloseTo(0.66, 5);
    expect(visibleShare('full', points)).toBeCloseTo(0.92, 5);
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
});
