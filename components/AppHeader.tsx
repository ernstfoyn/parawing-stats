"use client";

/**
 * The app's top bar.
 *
 * Before this the app had no top of its own: each page opened straight into its own heading, so
 * scrolling moved the identity of the app off screen and there was nowhere for a page-level control
 * to live. A thin sticky bar fixes both — the wordmark stays put, and the one control that belongs to
 * every session (the speed unit) has a home that does not move when the page does.
 *
 * The bar is deliberately almost empty. This is a local log with one rider in it, not a product with
 * navigation to do: the wordmark goes home, and anything page-specific is passed in as children.
 */

import Link from "next/link";
import type { ReactNode } from "react";

export default function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-paper/92 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6">
        <Link
          href="/"
          className="mono flex items-center gap-2 text-[0.62rem] uppercase tracking-[0.18em] text-ink transition-colors hover:text-graphite"
        >
          <span className="inline-block size-2 bg-signal" />
          Parawing stats
        </Link>
        <span className="mono text-[0.58rem] uppercase tracking-[0.12em] text-quiet">
          local only
        </span>
        {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}
