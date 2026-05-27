// Pure SVG sparkline. Renders the polyline through `values` and, optionally,
// a dashed horizontal target line at `target`. No interactivity, no client
// boundary — safe to import into server components.
//
// Extended for /retrospective with per-point colours and labels. When labels
// are passed in, the SVG also switches to aspect-ratio-preserving mode so
// the text doesn't get stretched horizontally (existing `xMidYMid meet`
// variant). Existing callers (forecast / goals) leave both off and get the
// original `preserveAspectRatio="none"` stretch behaviour.

interface SparklineProps {
  values: number[];
  /** When supplied, renders a dashed horizontal line at this value. */
  target?: number;
  /**
   * Per-point fill override. `undefined` entries fall back to `currentColor`,
   * so the array can be sparse — pass colours only for the dots that need
   * highlighting (e.g. red for negative-net periods).
   */
  pointColors?: (string | undefined)[];
  /**
   * Per-point text rendered below each dot. Length must match `values`.
   * Triggers a few automatic adjustments — see `preserveAspectRatio` below.
   */
  pointLabels?: string[];
  /**
   * Optional secondary series rendered as a muted line on top of the
   * primary one — used by /retrospective to overlay a rolling-average
   * trend. Must be the same length as `values` (or shorter — extra
   * trailing positions just won't render). Non-finite entries (NaN /
   * undefined) break the line into segments so gaps stay visually
   * honest rather than connecting across missing data.
   */
  trendValues?: (number | null | undefined)[];
  /** Logical pixel width — also the viewBox width. */
  width?: number;
  /** Logical pixel height — also the viewBox height. */
  height?: number;
  /**
   * SVG aspect handling. Defaults to `"none"` (existing stretch behaviour)
   * unless `pointLabels` is set, in which case it auto-flips to
   * `"xMidYMid meet"` so the text rendered inside the SVG isn't distorted
   * by the container's width.
   */
  preserveAspectRatio?: "none" | "xMidYMid meet";
  className?: string;
  ariaLabel?: string;
}

// Slate-400. Chosen to read as "supporting context" against the main
// `currentColor` line (typically slate-500 in the retrospective use)
// without disappearing on light backgrounds.
const TREND_STROKE = "#94a3b8";

const DEFAULT_W = 672;
const DEFAULT_H = 80;
const PADDING = 8;
const LABEL_BAND = 22;

export function Sparkline({
  values,
  target,
  pointColors,
  pointLabels,
  trendValues,
  width = DEFAULT_W,
  height = DEFAULT_H,
  preserveAspectRatio,
  className = "h-20 w-full",
  ariaLabel = "Trend",
}: SparklineProps) {
  if (values.length < 2) return null;

  // Reserve space at the bottom for labels so they don't overlap the dots.
  const labelBand = pointLabels ? LABEL_BAND : 0;
  const chartH = Math.max(20, height - labelBand);

  const aspect: "none" | "xMidYMid meet" =
    preserveAspectRatio ?? (pointLabels ? "xMidYMid meet" : "none");

  // Include `target` AND any finite trend values in the y-range so neither
  // the dashed target line nor the trend overlay clips outside the chart.
  const finiteTrendValues = (trendValues ?? []).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const min = Math.min(...values, ...finiteTrendValues, target ?? values[0]);
  const max = Math.max(...values, ...finiteTrendValues, target ?? values[0]);
  const range = max - min || 1;
  const stepX = (width - 2 * PADDING) / (values.length - 1);

  const yFor = (v: number) =>
    PADDING + (chartH - 2 * PADDING) * (1 - (v - min) / range);

  const coords = values.map((v, i) => {
    const x = PADDING + i * stepX;
    return [x, yFor(v)] as const;
  });
  const polyline = coords.map(([x, y]) => `${x},${y}`).join(" ");

  // Build trend segments — break at any non-finite entry so a missing point
  // shows as a gap rather than a line connecting across the absent value.
  // Single-point segments are dropped (a polyline needs ≥2 points).
  const trendSegments: string[] = [];
  if (trendValues && trendValues.length > 0) {
    let current: string[] = [];
    const flush = () => {
      if (current.length >= 2) trendSegments.push(current.join(" "));
      current = [];
    };
    const upTo = Math.min(trendValues.length, values.length);
    for (let i = 0; i < upTo; i++) {
      const v = trendValues[i];
      if (typeof v === "number" && Number.isFinite(v)) {
        const x = PADDING + i * stepX;
        current.push(`${x},${yFor(v)}`);
      } else {
        flush();
      }
    }
    flush();
  }

  const targetY = target === undefined ? null : yFor(target);
  // Render a faint zero baseline when the series straddles zero — useful
  // for net-cashflow style charts where the sign change is the story.
  const showZero = min < 0 && max > 0;
  const zeroY = showZero ? yFor(0) : null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={aspect}
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      {zeroY !== null && (
        <line
          x1={PADDING}
          x2={width - PADDING}
          y1={zeroY}
          y2={zeroY}
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.2}
        />
      )}
      {targetY !== null && (
        <line
          x1={PADDING}
          x2={width - PADDING}
          y1={targetY}
          y2={targetY}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="4 4"
          opacity={0.4}
        />
      )}
      {trendSegments.map((points, i) => (
        <polyline
          key={`trend-${i}`}
          points={points}
          fill="none"
          stroke={TREND_STROKE}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <polyline
        points={polyline}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {coords.map(([x, y], i) => {
        const fill = pointColors?.[i] ?? "currentColor";
        const r = pointLabels ? 3 : 2.5;
        return <circle key={i} cx={x} cy={y} r={r} fill={fill} />;
      })}
      {pointLabels?.map((label, i) => {
        const [x] = coords[i];
        return (
          <text
            key={`l${i}`}
            x={x}
            y={height - 6}
            textAnchor="middle"
            fontSize={11}
            fill="currentColor"
            opacity={0.75}
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}
