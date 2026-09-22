import type { ReactElement, SVGProps } from 'react';

/**
 * Khdemli brand mark.
 *
 * A hand-and-wrench inside a rounded square: craftsman's tool plus a palm that
 * reads as "someone will do it for you". Drawn on the same 24-grid as the rest
 * of the iconography so it optically matches the UI, with the brand aqua as the
 * fill and a deep ink stroke that survives on white, on aqua, and in dark mode.
 */

export function KhdemliMark({
  size = 32,
  variant = 'brand',
  className,
  ...rest
}: SVGProps<SVGSVGElement> & { size?: number; variant?: 'brand' | 'ink' | 'mono' }) {
  const fill = variant === 'ink' ? '#061f1a' : '#32F4BA';
  const glyph = variant === 'ink' ? '#32F4BA' : '#06231c';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill={fill} />
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" stroke="rgba(6,35,28,0.14)" strokeWidth="1.5" />
      {/* wrench */}
      <path
        d="M32.6 12.4a6.1 6.1 0 0 1-7.9 7.9l-8.2 8.2a2.3 2.3 0 1 0 3.2 3.2l8.2-8.2a6.1 6.1 0 0 1 7.9-7.9l-3.7 3.7 1.9 1.9z"
        fill={glyph}
      />
      {/* palm line: "khdemli" = do it for me */}
      <path
        d="M11.5 30.5c3.6 4.4 8.3 6.6 14 6.6 3.1 0 5.8-.7 8.1-2.1"
        stroke={glyph}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Mark + wordmark, for headers and footers. */
export function KhdemliLogo({
  size = 30,
  showTagline = false,
  className,
}: {
  size?: number;
  showTagline?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <KhdemliMark size={size} />
      <span className="flex flex-col leading-none">
        <span
          className="font-black tracking-tight"
          style={{ fontSize: size * 0.62, letterSpacing: '-0.03em' }}
        >
          Khdemli
        </span>
        {showTagline && (
          <span
            className="mt-0.5 font-semibold"
            style={{ fontSize: size * 0.26, color: 'rgb(var(--fg-muted))' }}
          >
            خدمات بالتقسيط
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * Category / service iconography.
 *
 * Inline SVG rather than an icon font: these inherit `currentColor`, stay crisp
 * at any size, and render identically on Android, iOS and desktop. The DB
 * stores a short icon *name* per category, which `iconForSlug` maps here — so
 * an admin can add a category without a deploy and still get a sane glyph.
 */

export type IconName =
  | 'home'
  | 'apartment'
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
  | 'layers'
  | 'fridge'
  | 'washer'
  | 'oven'
  | 'sofa'
  | 'drill'
  | 'search'
  | 'star'
  | 'chat'
  | 'phone'
  | 'nav'
  | 'wallet'
  | 'bell'
  | 'user'
  | 'plus'
  | 'minus'
  | 'check'
  | 'x'
  | 'chevron'
  | 'arrow'
  | 'camera'
  | 'doc'
  | 'crown'
  | 'badge'
  | 'radar'
  | 'route'
  | 'roller'
  | 'trowel'
  | 'bricks'
  | 'tiles'
  | 'needle'
  | 'plunger';

type IconProps = SVGProps<SVGSVGElement> & { name: IconName | string; size?: number };

const PATHS: Record<IconName, ReactElement> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  apartment: (
    <>
      <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
      <path d="M15 9h4a1 1 0 0 1 1 1v11" />
      <path d="M7 8h2M7 12h2M7 16h2M18 13h-1M18 17h-1" />
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
    <path d="M20.5 3.5a5 5 0 0 1-6.7 6.7L5 19a2.1 2.1 0 0 1-3-3l8.8-8.8a5 5 0 0 1 6.7-6.7l-3 3 2 2z" />
  ),
  hammer: (
    <path d="M14 3.5 20.5 10l-2.6 2.6-2-2-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8.6-8.6-2-2z" />
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
  water: <path d="M12 3s5.5 6.1 5.5 10a5.5 5.5 0 0 1-11 0C6.5 9.1 12 3 12 3z" />,
  flame: (
    <path d="M12 3c.8 3.2-2.6 4.7-2.6 8.2A3.4 3.4 0 0 0 12 14.6a3.4 3.4 0 0 0 2.6-3.4c0-1-.3-1.8-.8-2.5 2.4 1 4.2 3.3 4.2 6A6 6 0 0 1 6 14.7c0-4.6 4.6-5.6 6-11.7z" />
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
  spark: <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9z" />,
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
  fridge: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2" />
      <path d="M6 10h12M9 6v2M9 13.5v2" />
    </>
  ),
  washer: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <circle cx="12" cy="14" r="4" />
      <path d="M8 7h.01M11 7h.01" />
    </>
  ),
  oven: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 9h16M8 6h.01M11 6h.01" />
      <rect x="8" y="12.5" width="8" height="5.5" rx="1" />
    </>
  ),
  sofa: (
    <>
      <path d="M4 12V8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5V12" />
      <path d="M3 12.5a2 2 0 0 1 2 2V17h14v-2.5a2 2 0 0 1 2-2" />
      <path d="M6 17v1.5M18 17v1.5" />
    </>
  ),
  drill: (
    <>
      <path d="M4 8h9a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H9l-1 5H5l-1-5z" />
      <path d="M15 9h4.5a1.5 1.5 0 0 1 0 3H15" />
      <path d="M7 8V5.5h4V8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </>
  ),
  star: <path d="m12 3.2 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9z" />,
  chat: (
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5V15.9A1.5 1.5 0 0 1 4 14.5z" />
  ),
  phone: (
    <path d="M6.5 3.5h2.2l1.6 4-2 1.3a11.5 11.5 0 0 0 5.4 5.4l1.3-2 4 1.6v2.2a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z" />
  ),
  nav: <path d="M12 3 20 21l-8-3.4L4 21z" />,
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14" r="1.2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  arrow: (
    <>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  camera: (
    <>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.2-2h7l1.2 2h1.8A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </>
  ),
  crown: <path d="M4 18h16l-1.2-9-3.8 3.2L12 6l-3 6.2L5.2 9z" />,
  badge: (
    <>
      <path d="M12 3l2 1.6 2.5-.3 1.1 2.3 2.3 1.1-.3 2.5L21 12l-1.4 1.8.3 2.5-2.3 1.1-1.1 2.3-2.5-.3L12 21l-2-1.6-2.5.3-1.1-2.3L4 16.3l.3-2.5L3 12l1.4-1.8-.3-2.5 2.3-1.1L7.5 4.3l2.5.3z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  radar: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12l6-4" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18h5a4 4 0 0 0 0-8h-3a4 4 0 0 1 0-8h5" />
    </>
  ),

  /* The six crafts the customer picks from on the home screen. Same 24x24
     grid and round joins as the rest of the set so they read as one family. */
  roller: (
    <>
      <rect x="4" y="4" width="12" height="5" rx="1.4" />
      <path d="M16 6.5h2.5a1.5 1.5 0 0 1 1.5 1.5v2.5a1.5 1.5 0 0 1-1.5 1.5H10v2" />
      <path d="M8.5 14h3v6h-3z" />
    </>
  ),
  trowel: (
    <>
      <path d="M3.5 19 9 10.5l4.5 3z" />
      <path d="M13.5 13.5 19 5.5a1 1 0 0 1 1.6 1.2l-4.6 8.4z" />
      <path d="M4.5 20.5h5" />
    </>
  ),
  bricks: (
    <>
      <rect x="3" y="5" width="8" height="4.5" rx="1" />
      <rect x="13" y="5" width="8" height="4.5" rx="1" />
      <rect x="3" y="14.5" width="8" height="4.5" rx="1" />
      <rect x="13" y="14.5" width="8" height="4.5" rx="1" />
    </>
  ),
  tiles: (
    <>
      <path d="M3.5 3.5h8v8h-8z" />
      <path d="M12.5 3.5h8v8h-8z" />
      <path d="M3.5 12.5h8v8h-8z" />
      <path d="M12.5 12.5h8v8h-8z" />
    </>
  ),
  needle: (
    <>
      <path d="M20.5 3.5 9 15" />
      <path d="M5.5 18.5 9 15" />
      <path d="M4.5 20.9c1.6.3 3.1-.3 4.2-1.3 1-1 1.4-1.9 1.9-2.9.5-1-.2-1.9-1.2-1.9s-1.8.6-2.3 1.4c-.9 1.3-.9 2.6-2.6 4.7z" />
      <circle cx="17.8" cy="6.2" r="1.05" />
    </>
  ),
  plunger: (
    <>
      <path d="M4.5 12.5a7.5 5.5 0 0 1 15 0z" />
      <path d="M12 12.5V21" />
      <path d="M9.5 21h5" />
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

/** Filled variant for stars. */
export function StarIcon({ size = 16, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS.star}
    </svg>
  );
}

/**
 * Map a category or service slug to an icon when the row has none.
 * Keyword-based so newly seeded rows still look intentional.
 */
const SLUG_ICONS: Array<[RegExp, IconName]> = [
  [/painting|paint|wall-paint/, 'roller'],
  [/plaster|jabs|stucco|ceiling/, 'trowel'],
  [/mason|masonry|brick|macon|build|construct|renovat|cement/, 'bricks'],
  [/tiling|tile|tiler|zellige/, 'tiles'],
  [/tailor|coutur|sew|garment|alteration|curtain|upholster/, 'needle'],
  [/plumb|leak|drain|pipe|faucet|siphon|water-heater/, 'plunger'],
  [/electric|outlet|lighting|panel|switch|socket|wiring/, 'bolt'],
  [/handyman|assembly|mounting|general|tool|repair/, 'wrench'],
  [/washing|washer/, 'washer'],
  [/refrigerat|fridge/, 'fridge'],
  [/oven|stove|cooker/, 'oven'],
  [/appliance|dishwasher|microwave/, 'plug'],
  [/clean|housekeep|maid|sanit|deep-clean/, 'sparkles'],
  [/furniture|sofa|couch/, 'sofa'],
  [/move|mover|relocat|apartment-move/, 'truck'],
  [/deliver|delivery|courier|express|package|parcel/, 'box'],
  [/pickup|dropoff|collect|post-office|document/, 'doc'],
  [/grocer|shopping|market|pharmac/, 'cart'],
  [/errand|queue|waiting|hour/, 'clock'],
  [/assist|elder|help|care|carry|support/, 'shield'],
  [/build|construct|renovat|mason|cement|drill/, 'drill'],
  [/home|house|apartment|villa|studio/, 'home'],
  [/task|checklist|inspection|survey/, 'checklist'],
  [/city|area|location|map/, 'pin'],
];

export function iconForSlug(slug: string, fallbackIcon?: string | null): IconName {
  if (fallbackIcon && fallbackIcon in PATHS) return fallbackIcon as IconName;
  const s = slug.toLowerCase();
  for (const [re, icon] of SLUG_ICONS) if (re.test(s)) return icon;
  return 'spark';
}
