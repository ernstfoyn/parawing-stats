"use client";

/** Loads one session out of IndexedDB and hands it to the dashboard. */

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadEquipmentPresets, loadSession } from "@/lib/storage/sessions";
import type { EquipmentProfile, SessionRecord } from "@/lib/types";
import SessionDashboard from "./SessionDashboard";
import { Spinner } from "./ui";

type LoadState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; record: SessionRecord; presets: EquipmentProfile[] };

export default function SessionLoader({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [record, presets] = await Promise.all([loadSession(id), loadEquipmentPresets()]);
        if (cancelled) return;
        setState(record ? { status: "ready", record, presets } : { status: "missing" });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Could not read the session store.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.status === "loading") {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <Spinner label="Loading session…" />
      </div>
    );
  }
  if (state.status !== "ready") {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <div className="panel px-5 py-6">
          <h1 className="text-lg font-semibold text-ink">
            {state.status === "missing" ? "Session not found" : "Could not open the session"}
          </h1>
          <p className="mt-1 text-sm text-grey">
            {state.status === "missing"
              ? "This session is not in this browser's storage. It may have been imported on another device or deleted."
              : state.message}
          </p>
          <Link href="/" className="btn mt-4">
            Back to sessions
          </Link>
        </div>
      </div>
    );
  }

  return <SessionDashboard record={state.record} initialPresets={state.presets} />;
}
