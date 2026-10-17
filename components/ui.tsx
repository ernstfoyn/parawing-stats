"use client";

/**
 * Small presentational primitives shared by every view.
 *
 * Kept deliberately plain: a panel, a stat, a chip, a segmented control. The visual identity comes
 * from the theme tokens in `globals.css`, so there is one place to change a colour.
 */

import type { ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2 sm:px-5">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[0.95rem] font-semibold tracking-tight text-snow">{title}</h2>
            )}
            {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-fog">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`px-4 pb-4 sm:px-5 sm:pb-5 ${title ? "" : "pt-4 sm:pt-5"} ${bodyClassName}`}>
        {children}
      </div>
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
  accent?: "teal" | "ember" | "sky" | "muted";
  small?: boolean;
}) {
  const color =
    accent === "teal"
      ? "text-accent"
      : accent === "ember"
        ? "text-ember"
        : accent === "sky"
          ? "text-accent-2"
          : accent === "muted"
            ? "text-fog"
            : "text-snow";
  return (
    <div className="min-w-0">
      <div className="text-[0.66rem] font-semibold uppercase tracking-[0.09em] text-fog">
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span
          className={`${small ? "text-lg" : "text-2xl"} font-semibold tabular-nums tracking-tight ${color}`}
        >
          {value}
        </span>
        {unit && <span className="text-xs font-medium text-fog">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[0.7rem] leading-snug text-fog">{hint}</div>}
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
      style={color ? { borderColor: `${color}66`, color } : undefined}
    >
      {children}
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
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
      className="inline-flex rounded-lg border border-line bg-ink p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.value
              ? "bg-panel-2 text-snow"
              : "text-fog hover:text-mist"
          }`}
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
      {hint && <span className="mt-1 block text-[0.7rem] text-fog">{hint}</span>}
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
    <div className="flex flex-col items-start gap-3 py-8">
      <div>
        <p className="text-sm font-medium text-mist">{title}</p>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-fog">{body}</p>
      </div>
      {action}
    </div>
  );
}

export function QualityBadge({ quality }: { quality: "measured" | "modelled" | "manual" | null }) {
  if (!quality) return null;
  const map = {
    measured: { text: "measured", color: "#2dd4bf" },
    modelled: { text: "modelled", color: "#38bdf8" },
    manual: { text: "you entered this", color: "#b3c4d8" },
  } as const;
  const v = map[quality];
  return (
    <Chip color={v.color} title="Where the wind numbers came from.">
      {v.text}
    </Chip>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-fog">
      <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label}
    </div>
  );
}
