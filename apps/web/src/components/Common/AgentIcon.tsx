// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AgentIcon` — a small, static avatar used to visually distinguish external
 * agents. It renders one of the hand-drawn "basic shapes" (circle, diamond,
 * spark, five-petal flower, soft bean) filled with one of four fixed brand colors,
 * plus an optional subtle face.
 *
 * The shapes and colors are fixed brand-avatar art (the same palette the Huabu
 * logo uses), so the raw hex values here are intentional identity assets rather
 * than UI chrome — they are exempt from the semantic design-token rule that
 * applies to normal component styling.
 *
 * The icon is static by default because it appears in dense lists and menus.
 * Callers that represent live execution may opt into the working motion. The
 * shape body animates while the face stays upright.
 */

import './AgentIcon.css';

export const AGENT_ICON_SHAPES = [
  'circle',
  'diamond',
  'spark',
  'flower',
  'cloud',
] as const;
export type AgentIconShape = (typeof AGENT_ICON_SHAPES)[number];

/**
 * Shapes offered to external agents in the picker (and used for their derived /
 * random defaults). `circle` is intentionally excluded — it is reserved for the
 * user's own avatar — while it stays a valid {@link AgentIconShape} so it can
 * still be rendered elsewhere and any previously-saved value keeps working.
 */
export const AGENT_ICON_SELECTABLE_SHAPES = [
  'diamond',
  'spark',
  'flower',
  'cloud',
] as const;

export const AGENT_ICON_COLORS = ['blue', 'red', 'yellow', 'green'] as const;
export type AgentIconColor = (typeof AGENT_ICON_COLORS)[number];

export type AgentIconValue = {
  shape: AgentIconShape;
  color: AgentIconColor;
};

export type AgentIconMotion = 'none' | 'working';

/** Fixed brand-avatar palette (matches the Huabu logo dots). */
const COLOR_HEX: Record<AgentIconColor, string> = {
  blue: '#00A4EF',
  red: '#F25022',
  yellow: '#FFB900',
  green: '#7FBA00',
};

/**
 * The fixed brand hex for an {@link AgentIconColor}. Exposed so surfaces that
 * need to echo an agent's identity colour outside the SVG (e.g. a status ring
 * tinted to match the avatar) stay in sync with the avatar art.
 */
export function agentIconColorHex(color: AgentIconColor): string {
  return COLOR_HEX[color];
}

/** Ink used for the hand-drawn face strokes. */
const FACE_INK = '#24221E';

/**
 * Per-shape vertical nudge (viewBox units) that recentres a shape whose
 * artwork's optical centre does not coincide with the geometric viewBox centre
 * (60,60). The flower's single top petal + paired lower petals push its visible
 * mass slightly above centre, so it renders high inside a circular ring; the
 * nudge moves body and face together so it sits vertically centred.
 */
const SHAPE_OFFSET_Y: Partial<Record<AgentIconShape, number>> = {
  flower: 2.1,
};

/** Petal circle centers of the five-petal flower shape. */
const FLOWER_PETALS = Array.from({ length: 5 }, (_, i) => {
  const a = ((-90 + i * 72) * Math.PI) / 180;
  return {
    cx: Number((60 + Math.cos(a) * 22).toFixed(1)),
    cy: Number((60 + Math.sin(a) * 22).toFixed(1)),
  };
});

/** Hand-drawn face strokes per shape (ported from the basic-shapes library). */
const FACE_PATHS: Record<
  AgentIconShape,
  { rotate: number; strokes: readonly string[] }
> = {
  circle: {
    rotate: -3,
    strokes: [
      'M49 49 C48.5 52 48.5 55 49 58',
      'M70 48 C69.5 51 69.5 55 70 58',
      'M60 59 C56 65 55 69 61 72',
    ],
  },
  diamond: {
    rotate: 4,
    strokes: [
      'M50 50 L48 59',
      'M70 49 L69 57',
      'M65 66 C60 67 59 74 64 76 C69 77 72 72 69 68',
    ],
  },
  spark: {
    rotate: -5,
    strokes: ['M50 51 L49 58', 'M69 49 L68 57', 'M55 68 C59 72 64 72 67 68'],
  },
  flower: {
    rotate: 3,
    strokes: ['M50 49 L48 57', 'M70 51 L68 58', 'M55 69 C58 73 64 74 68 70'],
  },
  cloud: {
    rotate: 0,
    strokes: ['M50 50 L49 58', 'M70 50 L69 58', 'M54 69 C58 73 64 74 68 70'],
  },
};

function ShapeBody({ shape, fill }: { shape: AgentIconShape; fill: string }) {
  switch (shape) {
    case 'circle':
      return <circle cx="60" cy="60" r="34" fill={fill} />;
    case 'diamond':
      return <polygon points="60,18 102,60 60,102 18,60" fill={fill} />;
    case 'spark':
      return (
        <polygon
          points="60,23 72,48 98,60 72,72 60,97 48,72 22,60 48,48"
          fill={fill}
        />
      );
    case 'flower':
      return (
        <g fill={fill}>
          {FLOWER_PETALS.map((petal, i) => (
            <circle key={i} cx={petal.cx} cy={petal.cy} r="16" />
          ))}
          <circle cx="60" cy="60" r="17" />
        </g>
      );
    case 'cloud':
      return (
        <path
          d="M66 19C84 19 99 30 101 45C103 58 94 65 86 70C78 75 82 87 73 95C63 104 45 102 32 92C18 82 15 65 21 50C27 34 42 25 54 21C58 20 62 19 66 19Z"
          fill={fill}
          transform="translate(7.008 7.008) scale(0.8832)"
        />
      );
  }
}

export type AgentIconProps = {
  shape: AgentIconShape;
  color: AgentIconColor;
  /** Rendered pixel size (width and height). Defaults to 16. */
  size?: number;
  /**
   * Whether to draw the hand-drawn face. Defaults to `true` when the icon is
   * large enough (>= 20px) for the face to read clearly, otherwise `false`.
   */
  withFace?: boolean;
  /** Accessible label. When omitted the icon is treated as decorative. */
  title?: string;
  /** Optional semantic motion. Dense lists should keep the default `none`. */
  motion?: AgentIconMotion;
  className?: string;
};

export function AgentIcon({
  shape,
  color,
  size = 16,
  withFace,
  title,
  motion = 'none',
  className,
}: AgentIconProps) {
  const showFace = withFace ?? size >= 20;
  const face = FACE_PATHS[shape];
  const faceElement = showFace ? (
    <g
      transform={`rotate(${face.rotate} 60 60)`}
      fill="none"
      stroke={FACE_INK}
      strokeWidth={4.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {face.strokes.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </g>
  ) : null;
  const isWorking = motion === 'working';
  const offsetY = SHAPE_OFFSET_Y[shape] ?? 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox="18 18 84 84"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <g transform={offsetY ? `translate(0 ${offsetY})` : undefined}>
        {isWorking ? (
          <g className="agent-icon-working-avatar">
            <g className="agent-icon-working-body">
              <ShapeBody shape={shape} fill={COLOR_HEX[color]} />
            </g>
            {faceElement}
          </g>
        ) : (
          <>
            <g>
              <ShapeBody shape={shape} fill={COLOR_HEX[color]} />
            </g>
            {faceElement}
          </>
        )}
      </g>
    </svg>
  );
}
