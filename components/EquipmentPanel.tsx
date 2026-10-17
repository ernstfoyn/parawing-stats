"use client";

/**
 * Equipment editor.
 *
 * V1 keeps this deliberately simple: a flat form per session, plus named presets the rider can
 * reuse. The data model already carries everything a later comparison view needs (brand, model,
 * sizes, board volume), so comparing two sessions is a UI addition, not a schema change.
 */

import { useState } from "react";
import { EMPTY_EQUIPMENT } from "@/lib/types";
import type { EquipmentProfile } from "@/lib/types";
import { Field, Panel } from "./ui";

export interface EquipmentPanelProps {
  equipment: EquipmentProfile;
  presets: EquipmentProfile[];
  onChange: (equipment: EquipmentProfile) => void;
  onSavePreset: (preset: EquipmentProfile) => void;
  onDeletePreset: (id: string) => void;
}

function blank(): EquipmentProfile {
  return { ...EMPTY_EQUIPMENT, id: `equipment-${Math.random().toString(36).slice(2, 9)}` };
}

export default function EquipmentPanel({
  equipment,
  presets,
  onChange,
  onSavePreset,
  onDeletePreset,
}: EquipmentPanelProps) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof EquipmentProfile>(key: K, value: EquipmentProfile[K]) =>
    onChange({ ...equipment, [key]: value });

  const summary =
    [equipment.parawingBrand, equipment.parawingModel, equipment.parawingSizeM2 ? `${equipment.parawingSizeM2} m²` : null]
      .filter(Boolean)
      .join(" ") || "No equipment set";

  return (
    <Panel
      index="07"
      kicker="Equipment"
      title="What you rode"
      subtitle={open ? undefined : summary}
      actions={
        <>
          {!open && (
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
              Edit
            </button>
          )}
          {open && (
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Done
            </button>
          )}
        </>
      }
    >
      {presets.length > 0 && open && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {presets.map((p) => (
            <span key={p.id} className="inline-flex items-center">
              <button
                type="button"
                className="btn btn-ghost !rounded-r-none !border-r-0"
                title="Load this preset into the session"
                onClick={() => onChange({ ...p })}
              >
                {p.name || p.id}
              </button>
              <button
                type="button"
                className="btn btn-ghost !rounded-l-none !px-2 text-grey"
                title="Delete this preset"
                onClick={() => onDeletePreset(p.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {!open ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Row label="Parawing" value={`${equipment.parawingBrand} ${equipment.parawingModel}`.trim()} />
          <Row label="Size" value={equipment.parawingSizeM2 ? `${equipment.parawingSizeM2} m²` : ""} />
          <Row label="Foil" value={equipment.foilModel || equipment.foilSize} />
          <Row label="Stabilizer" value={equipment.stabilizer} />
          <Row label="Board" value={equipment.boardModel} />
          <Row label="Volume" value={equipment.boardVolumeL ? `${equipment.boardVolumeL} L` : ""} />
        </dl>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Profile name">
              <input
                className="input"
                value={equipment.name}
                placeholder="e.g. Gong Plus 4 / Veloce M"
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <Field label="Parawing brand">
              <input
                className="input"
                value={equipment.parawingBrand}
                onChange={(e) => set("parawingBrand", e.target.value)}
              />
            </Field>
            <Field label="Parawing model">
              <input
                className="input"
                value={equipment.parawingModel}
                onChange={(e) => set("parawingModel", e.target.value)}
              />
            </Field>
            <Field label="Parawing size (m²)">
              <input
                className="input"
                inputMode="decimal"
                value={equipment.parawingSizeM2 ?? ""}
                onChange={(e) =>
                  set("parawingSizeM2", e.target.value.trim() === "" ? null : Number(e.target.value))
                }
              />
            </Field>
            <Field label="Foil model">
              <input
                className="input"
                value={equipment.foilModel}
                onChange={(e) => set("foilModel", e.target.value)}
              />
            </Field>
            <Field label="Foil size / area">
              <input
                className="input"
                value={equipment.foilSize}
                onChange={(e) => set("foilSize", e.target.value)}
              />
            </Field>
            <Field label="Stabilizer">
              <input
                className="input"
                value={equipment.stabilizer}
                onChange={(e) => set("stabilizer", e.target.value)}
              />
            </Field>
            <Field label="Board">
              <input
                className="input"
                value={equipment.boardModel}
                onChange={(e) => set("boardModel", e.target.value)}
              />
            </Field>
            <Field label="Board volume (L)">
              <input
                className="input"
                inputMode="decimal"
                value={equipment.boardVolumeL ?? ""}
                onChange={(e) =>
                  set("boardVolumeL", e.target.value.trim() === "" ? null : Number(e.target.value))
                }
              />
            </Field>
            <Field label="Notes">
              <input
                className="input"
                value={equipment.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onSavePreset({ ...equipment, id: equipment.id || blank().id })}
            >
              Save as preset
            </button>
            <button type="button" className="btn" onClick={() => onChange(blank())}>
              New profile
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => onChange({ ...EMPTY_EQUIPMENT })}>
              Clear
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label mb-0.5">{label}</dt>
      <dd className="mono text-[0.76rem] text-ink">{value || "—"}</dd>
    </div>
  );
}
