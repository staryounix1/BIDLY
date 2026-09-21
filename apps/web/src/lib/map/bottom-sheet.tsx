'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Sheet } from 'react-modal-sheet';

/**
 * A draggable bottom sheet with snap points, built on react-modal-sheet.
 *
 * This is the inDrive/food-app shape: the map owns the screen and the form
 * lives on a tray you can pull up. Three detents are supported —
 * `peek` (a sliver with the primary action visible), `half` (the working
 * height) and `full` (everything).
 *
 * react-modal-sheet supplies the hard parts: touch/mouse drag with velocity and
 * rubber-banding, snap-point resolution, scroll-vs-drag arbitration inside the
 * content, and keyboard avoidance. We keep only what is product-specific — the
 * detent names, the Khdemli styling and the desktop side-card behaviour.
 *
 * `unstyled` is on purpose: the sheet ships opinionated visuals that would fight
 * the app theme, so we take the behaviour and paint it ourselves in globals.css.
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

/**
 * Detents in ascending snap-point order.
 *
 * react-modal-sheet validates that snap points ascend, and it prepends `0`
 * (closed) and appends `1` (fully open) on its own. A snap point is the share
 * of the sheet pushed *down* from fully-open, i.e. `1 - detentHeight`, so the
 * *tallest* detent produces the *smallest* point. `full` therefore comes first
 * and `peek` last. With the order fixed, index `i` is just `DETENTS[i]`, which
 * is what `initialSnap` and `onSnap` rely on.
 */
export const DETENTS: SheetDetent[] = ['full', 'half', 'peek'];

/**
 * Translate screen-share detents into react-modal-sheet snap points.
 *
 * The library turns a point into `translateY = (1 - point) * sheetHeight`, so a
 * detent that should cover 40% of the viewport needs the point `1 - 0.4 = 0.6`.
 * `heights` therefore describes how much of the screen each detent occupies,
 * which is the intuitive reading of `peek`/`half`/`full`.
 *
 * The result ascends because `DETENTS` is ordered tallest detent first, which
 * is what the library validates.
 *
 * Extracted as a pure function so the mapping is unit-testable without a DOM.
 */
export function detentSnapPoints(
  heights: Record<SheetDetent, number> = DEFAULT_HEIGHTS,
): number[] {
  return DETENTS.map((d) => 1 - heights[d]);
}

/** Index of a detent inside the snap-point array. */
export function detentSnapIndex(detent: SheetDetent): number {
  return DETENTS.indexOf(detent);
}

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
  const sheetHeight = useMemo(() => ({ ...DEFAULT_HEIGHTS, ...heights }), [heights]);
  const [active, setActive] = useState<SheetDetent>(initial);
  const [isDesktop, setIsDesktop] = useState(false);
  const [viewportH, setViewportH] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );

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

  // An external `detent` prop wins over internal state.
  useEffect(() => {
    if (detent) setActive(detent);
  }, [detent]);

  useEffect(() => {
    onDetentChange?.(active);
  }, [active, onDetentChange]);

  /**
   * Snap points are distances from the bottom of the viewport, as a share of
   * the sheet's own height. The sheet is sized to the viewport (minus any
   * offset) so the three detents land at the intended screen shares.
   */
  const snapPoints = useMemo(() => detentSnapPoints(sheetHeight), [sheetHeight]);

  const initialSnap = detentSnapIndex(initial);

  const onSnap = useCallback((index: number) => {
    // Snap points are in detent order, so the index maps straight across.
    const next = DETENTS[index];
    if (next) setActive(next);
  }, []);

  // On wide screens the sheet is a static side card (see `.compose-sheet`), so
  // the modal is not rendered at all — it would only fight the layout.
  if (isDesktop) {
    return (
      <div
        role="region"
        aria-label={label}
        className={['compose-sheet', 'compose-sheet--desktop', className ?? '']
          .filter(Boolean)
          .join(' ')}
      >
        <div className="compose-sheet-grip" aria-hidden />
        <div className="compose-sheet-body">{children}</div>
      </div>
    );
  }

  return (
    <Sheet
      isOpen
      unstyled
      disableDismiss
      disableScrollLocking
      detent="full"
      initialSnap={initialSnap}
      snapPoints={snapPoints}
      onSnap={onSnap}
      onClose={() => {
        /* The tray is persistent on this screen: it has no closed state, so a
           dismissal request (which `disableDismiss` already blocks) is a no-op. */
      }}
      className={['compose-sheet', className ?? ''].filter(Boolean).join(' ')}
      style={{
        // The sheet spans the viewport minus whatever chrome sits below it, so
        // `peek`/`half`/`full` map to the same screen shares as before.
        ['--compose-sheet-bottom' as string]: `${bottomOffset}px`,
        ['--compose-sheet-vh' as string]: `${viewportH - bottomOffset}px`,
        bottom: bottomOffset,
        height: viewportH - bottomOffset,
      }}
    >
      <Sheet.Container className="compose-sheet-panel">
        <Sheet.Header className="compose-sheet-head">
          <div className="compose-sheet-grip" />
        </Sheet.Header>
        <Sheet.Content
          className="compose-sheet-body"
          disableDrag={({ scrollPosition }) => scrollPosition !== 'top'}
        >
          <div className="compose-sheet-scroll">{children}</div>
        </Sheet.Content>
      </Sheet.Container>
    </Sheet>
  );
}
