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
import { Chip, EmptyState, Panel, Spinner } from "./ui";

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
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-snow">Foil Analyzer</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fog">
          Parawing, wingfoil and downwind session analysis. Import a Garmin or Strava{" "}
          <code className="rounded bg-panel px-1 py-0.5 text-[0.85em] text-mist">.fit</code> or{" "}
          <code className="rounded bg-panel px-1 py-0.5 text-[0.85em] text-mist">.gpx</code> file and
          see your upwind and downwind VMG, the wind you rode in, and every downwind surf run — all
          stored locally in your browser.
        </p>
      </header>

      {/* ------------------------------------------------------------------ import */}
      <Panel
        title="Import a session"
        subtitle="Files are read in your browser. Nothing is uploaded."
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
          className={`rounded-xl border-2 border-dashed px-5 py-8 text-center transition-colors ${
            dragging ? "border-accent bg-accent/5" : "border-line-soft bg-ink"
          }`}
        >
          <p className="text-sm text-mist">Drop a .fit or .gpx file here</p>
          <p className="mt-1 text-xs text-fog">or</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
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
          <p className="mt-3 text-[0.68rem] leading-relaxed text-fog">
            The demo is a synthetic session generated by the app — clearly labelled as such, and
            never presented as a real recording.
          </p>
        </div>

        {feedback.kind !== "idle" && (
          <div
            role="status"
            className={`mt-3 rounded-lg border px-3 py-2 text-[0.75rem] leading-relaxed ${
              feedback.kind === "error"
                ? "border-ember/40 bg-ember/10 text-ember"
                : feedback.kind === "ok"
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-line-soft bg-ink text-fog"
            }`}
          >
            {feedback.kind === "busy" ? (
              <Spinner label={feedback.message} />
            ) : (
              <>
                <p>{feedback.message}</p>
                {feedback.kind === "error" && feedback.hint && (
                  <p className="mt-1 text-fog">{feedback.hint}</p>
                )}
              </>
            )}
          </div>
        )}

        {fallback && (
          <p className="mt-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-[0.72rem] leading-relaxed text-amber">
            IndexedDB is unavailable in this browser, so sessions are being kept in localStorage
            instead. That works, but the space is small — importing very long sessions may fail.
          </p>
        )}
      </Panel>

      {/* ------------------------------------------------------------------- list */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-mist">
            Your sessions {sessions ? `(${sessions.length})` : ""}
          </h2>
          {sessions && sessions.length > 0 && (
            <Link href="/" className="text-[0.72rem] text-fog hover:text-mist" onClick={() => void refresh()}>
              refresh
            </Link>
          )}
        </div>

        {sessions == null ? (
          <Panel><Spinner label="Loading sessions…" /></Panel>
        ) : sessions.length === 0 ? (
          <Panel>
            <EmptyState
              title="No sessions yet"
              body="Import a file above, or load the demo activity to see how the analysis works before you have a real recording to hand."
            />
          </Panel>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <div className="panel panel-hover flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <Link href={`/sessions/${s.id}`} className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-snow">{s.name}</span>
                      {s.demo && (
                        <Chip color="#f59e0b" title="Synthetic demo data">
                          demo
                        </Chip>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-fog">
                      <span>{formatDateInOffset(s.startedAt, null)}</span>
                      <span>{formatDuration(s.durationS)}</span>
                      <span>{formatDistance(s.distanceM)}</span>
                      <span>
                        max {formatSpeed(s.maxSpeedMps, "kn")} kn
                        {s.maxSpeedMps != null ? ` / ${formatSpeed(s.maxSpeedMps, "mps")} m/s` : ""}
                      </span>
                      {s.downwindDistanceM > 0 && (
                        <span className="text-ember">DW {formatDistance(s.downwindDistanceM)}</span>
                      )}
                      <span>{s.windLabel}</span>
                      {s.equipmentName && <span>{s.equipmentName}</span>}
                      <span>{s.pointCount} fixes</span>
                    </div>
                  </Link>
                  <div className="flex items-center gap-1.5">
                    <Link href={`/sessions/${s.id}`} className="btn">
                      Open
                    </Link>
                    <button
                      type="button"
                      className="btn btn-ghost text-fog"
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
      </div>

      <footer className="mt-8 text-[0.68rem] leading-relaxed text-fog">
        <p>
          Sessions live only in this browser. Weather lookups are proxied by this deployment so API
          keys stay server-side; everything else runs locally. Wind from a weather station is an
          estimate of the conditions on your track, not a measurement of them.
        </p>
      </footer>
    </div>
  );
}
