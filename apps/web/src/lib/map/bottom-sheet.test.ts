import { describe, expect, it } from 'vitest';
import { detentSnapIndex, detentSnapPoints, DETENTS } from './bottom-sheet';

/**
 * react-modal-sheet turns a snap point into `translateY = (1 - point) * height`,
 * so the point is the share of the sheet pushed down from fully-open. These
 * tests pin the resulting on-screen geometry, which is the part that was easy
 * to get backwards.
 */
describe('detentSnapPoints', () => {
  const HEIGHTS = { peek: 0.4, half: 0.66, full: 0.92 };

  /** Share of the sheet that stays visible for a given detent. */
  const visibleShare = (detent: 'peek' | 'half' | 'full', points: number[]) =>
    1 - (points[detentSnapIndex(detent)] as number);

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

  it('gives the tallest detent the smallest (least translated) point', () => {
    const points = detentSnapPoints();
    const full = points[detentSnapIndex('full')] as number;
    const peek = points[detentSnapIndex('peek')] as number;
    expect(full).toBeLessThan(peek);
  });

  it('orders a taller detent as strictly more visible than a shorter one', () => {
    const points = detentSnapPoints();
    expect(visibleShare('full', points)).toBeGreaterThan(visibleShare('half', points));
    expect(visibleShare('half', points)).toBeGreaterThan(visibleShare('peek', points));
  });
});

describe('detentSnapIndex', () => {
  it('maps each detent to its own slot in the ascending array', () => {
    DETENTS.forEach((detent, i) => {
      expect(detentSnapIndex(detent)).toBe(i);
    });
  });

  it('puts peek last, since it is the shortest detent', () => {
    expect(detentSnapIndex('peek')).toBe(DETENTS.length - 1);
  });

  it('returns -1 for an unknown detent rather than a wrong slot', () => {
    expect(detentSnapIndex('nope' as never)).toBe(-1);
  });
});
