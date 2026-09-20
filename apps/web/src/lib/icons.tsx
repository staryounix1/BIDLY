import type { ReactElement, SVGProps } from 'react';

/**
 * Category / service iconography.
 *
 * Inline SVG rather than an icon font or emoji: these inherit `currentColor`,
 * stay crisp at every size, and render identically on Android, iOS and desktop.
 * The DB stores a short icon *name* per category (`categories.icon`), which
 * `iconForSlug` maps onto these components — so an admin can add a category
 * without a deploy and still get a sensible glyph.
 */

export type IconName =
  | 'home'
  | 'truck'
  | 'checklist'
  | 'bolt'
  | 'wrench'
  | 'hammer'
  | 'paint'
  | 'sparkles'
  | 'plug'
  | 'water'
  | 'flame'
  | 'box'
  | 'cart'
  | 'clock'
  | 'spark'
  | 'shield'
  | 'pin'
  | 'layers';

type IconProps = SVGProps<SVGSVGElement> & { name: IconName | string; size?: number };

const PATHS: Record<IconName, ReactElement> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  truck: (
    <>
      <path d="M2 7a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v8H2z" />
      <path d="M13 9h4l3 3.5V15h-7z" />
      <circle cx="6" cy="18" r="1.8" />
      <circle cx="16.5" cy="18" r="1.8" />
      <path d="M7.8 18h6.9M2 18h2.2M18.3 18H21" />
    </>
  ),
  checklist: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m2.5 6 1.5 1.5L7 4.5" />
      <path d="m2.5 12 1.5 1.5L7 10.5" />
      <path d="m2.5 18 1.5 1.5L7 16.5" />
    </>
  ),
  bolt: <path d="M13.5 2 4 13.2h6.2L10 22l9.6-11.2H13.4z" />,
  wrench: (
    <>
      <path d="M20.5 3.5a5 5 0 0 1-6.7 6.7L5 19a2.1 2.1 0 0 1-3-3l8.8-8.8a5 5 0 0 1 6.7-6.7l-3 3 2 2z" />
    </>
  ),
  hammer: (
    <>
      <path d="M14 3.5 20.5 10l-2.6 2.6-2-2-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8.6-8.6-2-2z" />
    </>
  ),
  paint: (
    <>
      <path d="M4 4h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9v2" />
      <rect x="7.5" y="14" width="3" height="7" rx="1.2" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 1.7 4.9L18.5 9.5l-4.8 1.6L12 16l-1.7-4.9L5.5 9.5l4.8-1.6z" />
      <path d="M18.5 15.5 19.6 18l2.4 1-2.4.9-1.1 2.6-1.1-2.6L15 19l2.4-1z" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
      <path d="M12 17v4" />
    </>
  ),
  water: (
    <>
      <path d="M12 3s5.5 6.1 5.5 10a5.5 5.5 0 0 1-11 0C6.5 9.1 12 3 12 3z" />
    </>
  ),
  flame: (
    <>
      <path d="M12 3c.8 3.2-2.6 4.7-2.6 8.2A3.4 3.4 0 0 0 12 14.6a3.4 3.4 0 0 0 2.6-3.4c0-1-.3-1.8-.8-2.5 2.4 1 4.2 3.3 4.2 6A6 6 0 0 1 6 14.7c0-4.6 4.6-5.6 6-11.7z" />
    </>
  ),
  box: (
    <>
      <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </>
  ),
  cart: (
    <>
      <circle cx="9" cy="20" r="1.6" />
      <circle cx="18" cy="20" r="1.6" />
      <path d="M2.5 3h2.2l2.6 12.2h12L21 6.5H5.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.4l3.4 2" />
    </>
  ),
  spark: (
    <>
      <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7.5 2.8v5.4c0 4.4-3.1 8.2-7.5 9.6-4.4-1.4-7.5-5.2-7.5-9.6V5.8z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s6.5-5.6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21z" />
      <circle cx="12" cy="10.5" r="2.4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
};

/** DB icon name -> component. Unknown names fall back to a neutral glyph. */
export function CategoryIcon({ name, size = 22, ...rest }: IconProps) {
  const key = (name in PATHS ? name : 'layers') as IconName;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[key]}
    </svg>
  );
}

/**
 * Map a category or service slug to an icon when the row has none.
 * Keyword-based so newly seeded rows still look intentional.
 */
const SLUG_ICONS: Array<[RegExp, IconName]> = [
  [/plumb|leak|drain|pipe|water-heater|faucet|siphon/, 'water'],
  [/electric|outlet|lighting|panel|switch|socket|wiring/, 'bolt'],
  [/handyman|assembly|mounting|repair|general|tool/, 'wrench'],
  [/appliance|washing|refrigerat|oven|dishwasher|microwave/, 'plug'],
  [/paint|wall|plaster|coating/, 'paint'],
  [/clean|housekeep|maid|sanit|deep-clean/, 'sparkles'],
  [/furniture|move|mover|relocat/, 'truck'],
  [/deliver|delivery|courier|express|shipment/, 'box'],
  [/pickup|dropoff|collect|post-office|parcel/, 'layers'],
  [/grocer|shopping|market|pharmac|errand|queue/, 'cart'],
  [/assist|elder|help|care|carry|support/, 'shield'],
  [/build|construct|renovat|mason|cement/, 'hammer'],
  [/hour|time|schedule|urgent/, 'clock'],
  [/home|house|apartment|villa/, 'home'],
  [/task|checklist|inspection|survey/, 'checklist'],
];

export function iconForSlug(slug: string, fallbackIcon?: string | null): IconName {
  if (fallbackIcon && fallbackIcon in PATHS) return fallbackIcon as IconName;
  const s = slug.toLowerCase();
  for (const [re, icon] of SLUG_ICONS) if (re.test(s)) return icon;
  return 'spark';
}
