"use client";

/**
 * Sessions overview.
 *
 * Import lives here, together with the session list. Everything is local: files are parsed in the
 * browser, the cleaned track is stored in IndexedDB, and the only network call the app ever makes
 * is the optional weather lookup, which goes through this deployment's own proxy.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImportError } from "@/lib/import";
import {
  deleteSession,
  ensureDemoSession,
  importSessionFile,
  listSessions,
} from "@/lib/storage/sessions";
import { usingFallbackStorage } from "@/lib/storage/db";
import { formatDistance, formatDuration, formatSpeed, formatDateInOffset } from "@/lib/units";
import type { SessionSummary } from "@/lib/types";
import { Chip, EmptyState, Note, Panel, Spinner } from "./ui";

type Feedback =
  | { kind: "idle" }
  | { kind: "busy"; message: string }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string; hint: string | null };

export default function SessionsView() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [fallback, setFallback] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setSessions(await listSessions());
  }, []);

  useEffect(() => {
    let cancelled = false;
    listSessions().then((list) => {
      if (cancelled) return;
      setSessions(list);
      setFallback(usingFallbackStorage());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      for (const file of list) {
        setFeedback({ kind: "busy", message: `Reading ${file.name}…` });
        try {
          const outcome = await importSessionFile(file);
          if (outcome.status === "duplicate") {
            setFeedback({
              kind: "error",
              message: `${file.name} was already imported.`,
              hint: `It matches "${outcome.existing.name}", imported ${formatDateInOffset(outcome.existing.importedAt, null)}. Opening the existing session instead of making a second copy.`,
            });
            await refresh();
            router.push(`/sessions/${outcome.existing.id}`);
            return;
          }
          setFeedback({
            kind: "ok",
            message: `Imported ${file.name}: ${outcome.record.points.length} fixes kept.`,
          });
          await refresh();
          router.push(`/sessions/${outcome.record.id}`);
          return;
        } catch (err) {
          const hint = err instanceof ImportError ? err.hint : null;
          setFeedback({
            kind: "error",
            message: err instanceof Error ? err.message : `Could not read ${file.name}.`,
            hint,
          });
          return;
        }
      }
    },
    [refresh, router],
  );

  const loadDemo = useCallback(async () => {
    setFeedback({ kind: "busy", message: "Building the demo session…" });
    try {
      const id = await ensureDemoSession();
      await refresh();
      router.push(`/sessions/${id}`);
    } catch (err) {
      setFeedback({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not build the demo session.",
        hint: null,
      });
    }
  }, [refresh, router]);

  const onDelete = useCallback(
    async (id: string, name: string) => {
      await deleteSession(id);
      await refresh();
      setFeedback({ kind: "ok", message: `Deleted "${name}".` });
    },
    [refresh],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-10 sm:px-6">
      <header className="mb-8">
        <div className="mono mb-3 flex items-center gap-2 text-[0.62rem] uppercase tracking-[0.18em] text-grey">
          <span className="inline-block size-2 bg-signal" />
          Parawing stats
          <span className="text-quiet">/</span>
          Local only
        </div>
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight text-ink sm:text-5xl">
          Parawing <span className="text-grey">/ wingfoil &amp; downwind session analysis</span>
        </h1>
        <p className="mono mt-4 max-w-2xl text-[0.72rem] leading-relaxed text-graphite">
          Import a Garmin or Strava <span className="bg-sunk px-1">.fit</span> or{" "}
          <span className="bg-sunk px-1">.gpx</span> file and read your upwind VMG, the wind
          you rode in, and every downwind run — all stored in your own browser.
        </p>
      </header>

      {/* ------------------------------------------------------------------ import */}
      <Panel
        index="01"
        kicker="Import"
        title="Add a session"
        subtitle="Files are parsed in your browser. Nothing is uploaded anywhere."
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void handleFiles(e.dataTransfer.files);
          }}
          className={`border border-dashed px-5 py-10 text-center transition-colors ${
            dragging ? "border-signal bg-signal/8" : "border-rule bg-sunk"
          }`}
        >
          <p className="mono text-[0.7rem] uppercase tracking-[0.12em] text-graphite">
            Drop a .fit or .gpx file here
          </p>
          <p className="mono mt-1 text-[0.62rem] uppercase tracking-[0.1em] text-grey">or</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()}>
              Choose a file
            </button>
            <button type="button" className="btn" onClick={loadDemo}>
              Load demo activity
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".fit,.gpx,application/octet-stream,application/gpx+xml,text/xml"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <p className="mx-auto mt-4 max-w-md text-[0.66rem] leading-relaxed text-grey">
            The demo is a synthetic session generated by the app — labelled as such everywhere, and
            never presented as a real recording.
          </p>
        </div>

        {feedback.kind !== "idle" && (
          <div role="status" className="mt-3">
            {feedback.kind === "busy" ? (
              <Note>
                <Spinner label={feedback.message} />
              </Note>
            ) : feedback.kind === "error" ? (
              <Note tone="warn">
                <span className="block">{feedback.message}</span>
                {feedback.hint && <span className="mt-1 block text-grey">{feedback.hint}</span>}
              </Note>
            ) : (
              <Note tone="signal">{feedback.message}</Note>
            )}
          </div>
        )}

        {fallback && (
          <div className="mt-3">
            <Note tone="warn">
              IndexedDB is unavailable in this browser, so sessions are being kept in localStorage
              instead. That works, but the space is small — importing very long sessions may fail.
            </Note>
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------------------------- list */}
      <div className="mt-6">
        <Panel
          index="02"
          kicker="Sessions"
          title={`Your sessions ${sessions ? `(${sessions.length})` : ""}`}
          subtitle="Everything you have imported on this device."
          actions={
            sessions && sessions.length > 0 ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void refresh()}
              >
                Refresh
              </button>
            ) : undefined
          }
        >
          {sessions == null ? (
            <Spinner label="Loading sessions…" />
          ) : sessions.length === 0 ? (
            <EmptyState
              title="No sessions yet"
              body="Import a file above, or load the demo activity to see how the analysis works before you have a real recording to hand."
            />
          ) : (
            <ul className="divide-y divide-quiet border-t border-quiet">
              {sessions.map((s) => (
                <li key={s.id}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                    <Link href={`/sessions/${s.id}`} className="min-w-0 flex-1 group">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[0.95rem] font-semibold text-ink group-hover:underline">
                          {s.name}
                        </span>
                        {s.demo && (
                          <Chip color="#e0763a" title="Synthetic demo data">
                            demo
                          </Chip>
                        )}
                      </div>
                      <div className="mono mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.64rem] uppercase tracking-[0.05em] text-grey">
                        <span>{formatDateInOffset(s.startedAt, null)}</span>
                        <span className="text-quiet">•</span>
                        <span>{formatDuration(s.durationS)}</span>
                        <span className="text-quiet">•</span>
                        <span>{formatDistance(s.distanceM)}</span>
                        <span className="text-quiet">•</span>
                        <span>
                          max {formatSpeed(s.maxSpeedMps, "kn")} kn
                          {s.maxSpeedMps != null ? ` / ${formatSpeed(s.maxSpeedMps, "mps")} m/s` : ""}
                        </span>
                        {s.downwindDistanceM > 0 && (
                          <>
                            <span className="text-quiet">•</span>
                            <span className="text-origin">DW {formatDistance(s.downwindDistanceM)}</span>
                          </>
                        )}
                        <span className="text-quiet">•</span>
                        <span>{s.windLabel}</span>
                        {s.equipmentName && (
                          <>
                            <span className="text-quiet">•</span>
                            <span>{s.equipmentName}</span>
                          </>
                        )}
                        <span className="text-quiet">•</span>
                        <span>{s.pointCount} fixes</span>
                      </div>
                    </Link>
                    <div className="flex items-center gap-1.5">
                      <Link href={`/sessions/${s.id}`} className="btn">
                        Open
                      </Link>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        title="Delete this session from this browser"
                        onClick={() => void onDelete(s.id, s.name)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <footer className="mt-8 border-t border-quiet pt-4 text-[0.68rem] leading-relaxed text-grey">
        <p>
          Sessions live only in this browser. Weather lookups are proxied by this deployment so API
          keys stay server-side; everything else runs locally. Wind from a weather station is an
          estimate of the conditions on your track, not a measurement of them.
        </p>
      </footer>
    </div>
  );
}
