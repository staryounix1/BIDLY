'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A draggable bottom sheet with snap points.
 *
 * This is the inDrive/food-app shape: the map owns the screen and the form
 * lives on a tray you can pull up. Three detents are supported —
 * `peek` (a sliver with the primary action visible), `half` (the working
 * height) and `full` (everything).
 *
 * Drag is pointer-based (mouse + touch + pen) rather than touch-only, so the
 * same component behaves on a laptop. While dragging we write the transform
 * directly and disable transitions; on release we snap to the nearest detent
 * and re-enable them. That split is what keeps the tray glued to the finger
 * instead of lagging a frame behind it.
 *
 * On wide screens the sheet is a static side card (see `.compose-sheet`), so
 * all drag/snap work is skipped there — it would only fight the layout.
 */

export type SheetDetent = 'peek' | 'half' | 'full';

export interface BottomSheetProps {
  /** Fraction of the viewport height for each detent, e.g. { peek: 0.38 }. */
  heights?: Partial<Record<SheetDetent, number>>;
  /** Detent the sheet opens at. */
  initial?: SheetDetent;
  /** Reports the active detent as the user drags it. */
  onDetentChange?: (detent: SheetDetent) => void;
  /** Pins the sheet to this detent (used to force it open for errors). */
  detent?: SheetDetent;
  /** Distance from the bottom of the viewport, in px (e.g. a nav bar). */
  bottomOffset?: number;
  /** Rendered inside the scrollable region. */
  children: ReactNode;
  /** Accessible label for the sheet region. */
  label?: string;
  className?: string;
}

const DEFAULT_HEIGHTS: Record<SheetDetent, number> = {
  peek: 0.4,
  half: 0.66,
  full: 0.92,
};

const DETENTS: SheetDetent[] = ['peek', 'half', 'full'];

export function BottomSheet({
  heights,
  initial = 'peek',
  onDetentChange,
  detent,
  bottomOffset = 0,
  children,
  label,
  className,
}: BottomSheetProps) {
  const sheetHeight = { ...DEFAULT_HEIGHTS, ...heights };
  const ref = useRef<HTMLDivElement | null>(null);
  const [viewportH, setViewportH] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );
  const [active, setActive] = useState<SheetDetent>(initial);
  const [dragY, setDragY] = useState<number | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);

  // Track viewport height so `peek`/`half` keep the same visual share when the
  // mobile keyboard or browser chrome changes the available space.
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    const mq = window.matchMedia('(min-width: 900px)');
    const onMq = () => setIsDesktop(mq.matches);
    onMq();
    window.addEventListener('resize', onResize);
    mq.addEventListener('change', onMq);
    return () => {
      window.removeEventListener('resize', onResize);
      mq.removeEventListener('change', onMq);
    };
  }, []);

  const toY = useCallback(
    (d: SheetDetent) => Math.max(0, viewportH * (1 - sheetHeight[d]) - bottomOffset),
    [viewportH, sheetHeight, bottomOffset],
  );

  // An external `detent` prop wins over internal state.
  useEffect(() => {
    if (detent) setActive(detent);
  }, [detent]);

  useEffect(() => {
    onDetentChange?.(active);
  }, [active, onDetentChange]);

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      if (isDesktop) return;
      event.preventDefault();
      const startPointerY = event.clientY;
      const startY = toY(active);
      let moved = false;

      const onMove = (e: PointerEvent) => {
        const delta = e.clientY - startPointerY;
        if (Math.abs(delta) > 3) moved = true;
        // Clamp between the tallest and shortest detents so the tray cannot be
        // flung off either edge.
        const min = toY('full');
        const max = toY('peek');
        setDragY(Math.min(max, Math.max(min, startY + delta)));
      };

      const onUp = (e: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        setDragY(null);
        if (!moved) return;

        // Snap to whichever detent the release point is closest to; ties go to
        // the direction of travel so a flick forwards always advances.
        const releasedY = startY + (e.clientY - startPointerY);
        let best: SheetDetent = active;
        let bestDist = Infinity;
        for (const d of DETENTS) {
          const dist = Math.abs(toY(d) - releasedY);
          if (dist < bestDist) {
            bestDist = dist;
            best = d;
          }
        }
        setActive(best);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [active, isDesktop, toY],
  );

  const toggle = useCallback(() => {
    if (isDesktop) return;
    setActive((prev) => (prev === 'peek' ? 'half' : prev === 'half' ? 'full' : 'peek'));
  }, [isDesktop]);

  const y = dragY ?? toY(active);

  return (
    <div
      ref={ref}
      role="region"
      aria-label={label}
      className={[
        'compose-sheet',
        isDesktop ? 'compose-sheet--desktop' : '',
        dragY === null ? 'compose-sheet--settling' : 'compose-sheet--dragging',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={isDesktop ? undefined : { height: `${sheetHeight.full * 100}%`, transform: `translateY(${y}px)` }}
    >
      <div
        className="compose-sheet-grip"
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-expanded={active !== 'peek'}
        onPointerDown={startDrag}
        onDoubleClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      />
      <div className="compose-sheet-body">{children}</div>
    </div>
  );
}
