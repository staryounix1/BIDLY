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

export const DETENTS: SheetDetent[] = ['peek', 'half', 'full'];

/**
 * Translate screen-share detents into react-modal-sheet snap points.
 *
 * The library measures snap points as a distance from the *bottom* of the sheet
 * as a share of the sheet's height, so a detent covering 40% of the screen is
 * `1 - 0.4 = 0.6`. Points must ascend and include 0 and 1, which is why the
 * detents are listed shortest-first and the closed/open ends are added.
 *
 * Extracted as a pure function so the mapping is unit-testable without a DOM.
 */
export function detentSnapPoints(
  heights: Record<SheetDetent, number> = DEFAULT_HEIGHTS,
): number[] {
  const points = DETENTS.map((d) => 1 - heights[d]);
  return [0, ...points, 1].sort((a, b) => a - b);
}

/** Index of a detent inside the snap-point array (the leading 0 shifts it by 1). */
export function detentSnapIndex(detent: SheetDetent): number {
  return DETENTS.indexOf(detent) + 1;
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
    // Index 0 is the closed snap and the last is fully open; the detents sit
    // between them, so shift back by one to map onto the named detents.
    const next = DETENTS[index - 1];
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
