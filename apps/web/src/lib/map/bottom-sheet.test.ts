import { describe, expect, it } from 'vitest';
import { detentSnapIndex, detentSnapPoints, DETENTS } from './bottom-sheet';

describe('detentSnapPoints', () => {
  it('converts screen shares into bottom-up snap points', () => {
    // A detent covering 40% of the screen sits 60% up from the bottom.
    const points = detentSnapPoints({ peek: 0.4, half: 0.66, full: 0.92 });
    const near = (expected: number) =>
      points.some((p) => Math.abs(p - expected) < 1e-9);
    expect(near(0.6)).toBe(true);
    expect(near(0.34)).toBe(true);
    expect(near(0.08)).toBe(true);
  });

  it('includes 0 (closed) and 1 (fully open), as the library requires', () => {
    const points = detentSnapPoints();
    expect(points[0]).toBe(0);
    expect(points[points.length - 1]).toBe(1);
  });

  it('returns points in ascending order', () => {
    const points = detentSnapPoints();
    for (let i = 1; i < points.length; i++) {
      expect(points[i] as number).toBeGreaterThanOrEqual(points[i - 1] as number);
    }
  });

  it('stays ascending when a detent is taller than the full sheet', () => {
    // A misconfigured 0.98 "full" must not produce an out-of-order snap point.
    const points = detentSnapPoints({ peek: 0.4, half: 0.66, full: 0.98 });
    for (let i = 1; i < points.length; i++) {
      expect(points[i] as number).toBeGreaterThanOrEqual(points[i - 1] as number);
    }
  });
});

describe('detentSnapIndex', () => {
  it('offsets by one to account for the leading closed snap point', () => {
    expect(detentSnapIndex('peek')).toBe(1);
    expect(detentSnapIndex('half')).toBe(2);
    expect(detentSnapIndex('full')).toBe(3);
  });

  it('aligns with the detent order', () => {
    DETENTS.forEach((detent, i) => {
      expect(detentSnapIndex(detent)).toBe(i + 1);
    });
  });
});
