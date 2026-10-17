"use client";

/**
 * Small presentational primitives shared by every view.
 *
 * Kept deliberately plain: a plate, a stat, a chip, a segmented control. The visual identity lives
 * in the theme tokens in `globals.css`, so there is one place to change a colour. The recurring
 * device is the numbered bracket tag — `01 / WIND` — which gives every panel the same masthead.
 */

import type { ReactNode } from "react";

export function Panel({
  index,
  kicker,
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyClassName = "",
}: {
  /** two-digit plate number, e.g. "01" */
  index?: string;
  /** short mono label printed next to the number, e.g. "WIND" */
  kicker?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const hasHead = Boolean(index || kicker || title || subtitle || actions);
  return (
    <section className={`panel ${className}`}>
      {hasHead && (
        <header className="panel-head">
          <div className="min-w-0 flex-1">
            {(index || kicker) && (
              <div className="mb-1 flex items-center gap-2">
                {index && <span className="panel-index">{index}</span>}
                {kicker && <span className="panel-kicker">{kicker}</span>}
              </div>
            )}
            {title && <h2 className="panel-title">{title}</h2>}
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`px-4 py-4 sm:px-5 sm:py-5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  hint,
  accent,
  small,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  accent?: "signal" | "origin" | "familiar" | "reach" | "grey";
  small?: boolean;
}) {
  const color =
    accent === "signal"
      ? "text-signal"
      : accent === "origin"
        ? "text-origin"
        : accent === "familiar"
          ? "text-familiar"
          : accent === "reach"
            ? "text-reach"
            : accent === "grey"
              ? "text-grey"
              : "text-ink";
  return (
    <div className="min-w-0">
      <div className="label mb-1">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span
          className={`${small ? "text-lg" : "text-[1.7rem] leading-none"} whitespace-nowrap font-semibold tracking-tight ${color}`}
        >
          {value}
        </span>
        {unit && <span className="mono text-[0.66rem] text-grey">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-[0.68rem] leading-snug text-grey">{hint}</div>}
    </div>
  );
}

export function Chip({
  children,
  color,
  title,
  className = "",
}: {
  children: ReactNode;
  color?: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={`chip ${className}`}
      title={title}
      style={color ? { borderColor: color, color } : undefined}
    >
      {children}
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex border border-ink bg-card"
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`mono px-2.5 py-1.5 text-[0.64rem] font-bold uppercase tracking-[0.08em] transition-colors ${
            i > 0 ? "border-l border-ink" : ""
          } ${value === o.value ? "bg-ink text-card" : "text-grey hover:bg-sunk hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[0.68rem] text-grey">{hint}</span>}
    </label>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 max-w-prose text-[0.76rem] leading-relaxed text-grey">{body}</p>
      </div>
      {action}
    </div>
  );
}

export function QualityBadge({ quality }: { quality: "measured" | "modelled" | "manual" | null }) {
  if (!quality) return null;
  const map = {
    measured: { text: "measured", color: "#14a45c" },
    modelled: { text: "modelled", color: "#0f7c7c" },
    manual: { text: "you entered this", color: "#4b4944" },
  } as const;
  const v = map[quality];
  return (
    <Chip color={v.color} title="Where the wind numbers came from.">
      {v.text}
    </Chip>
  );
}

export function Spinner({ label }: { label?: string }) {
  // A span, not a div: the spinner is also dropped inside `Note` (a <p>) and inside <label> in the
  // wind panel, and a block element there is invalid HTML and a hydration error in React.
  return (
    <span className="mono inline-flex items-center gap-2 align-middle text-[0.68rem] uppercase tracking-[0.08em] text-grey">
      <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-quiet border-t-signal" />
      {label}
    </span>
  );
}

/** A one-line note, used for the honest caveats that sit under a block of numbers. */
export function Note({
  children,
  tone = "quiet",
}: {
  children: ReactNode;
  tone?: "quiet" | "warn" | "signal";
}) {
  const styles =
    tone === "warn"
      ? "border-origin/50 bg-origin/8 text-graphite"
      : tone === "signal"
        ? "border-signal/50 bg-signal/8 text-graphite"
        : "border-quiet bg-sunk text-grey";
  return (
    <p className={`border px-3 py-2 text-[0.72rem] leading-relaxed ${styles}`}>{children}</p>
  );
}
