import React, { ChangeEvent, useState } from "react";
import type { ShapeSummary } from "./ShapeListPanel";
import { ActionsMenu } from "./ActionsMenu";

type Props = {
  zoneSummaries: ShapeSummary[];
  /** Pipe spacing per zone (id -> m); fallback to defaultPipeSpacingM when missing. */
  pipeSpacingByZoneId: Record<string, number>;
  defaultPipeSpacingM: number;
  onDimensionChange: (zoneId: string, field: "width" | "height", value: number) => void;
  onPipeSpacingChange: (zoneId: string, value: number) => void;
  onClone?: (zoneId: string) => void;
  onDelete?: (zoneId: string) => void;
  onExpand?: (zoneId: string) => void;
  canExpand?: (zoneId: string) => boolean;
  draft?: { width: number; height: number } | null;
  onDraftDimensionChange?: (field: "width" | "height", value: number) => void;
  emptyMessage?: string;
  cancelHint?: string;
};

export const ZonesPanel: React.FC<Props> = ({
  zoneSummaries,
  pipeSpacingByZoneId,
  defaultPipeSpacingM,
  onDimensionChange,
  onPipeSpacingChange,
  onClone,
  onDelete,
  onExpand,
  canExpand,
  draft,
  onDraftDimensionChange,
  emptyMessage = "Draw rooms first, then draw zones inside them.",
  cancelHint = 'Press Esc or "Cancel draft" to cancel.'
}) => {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  return (
    <div>
      <div className="panel-title">
        <span>Zones</span>
        <span className="panel-subtitle">
          Per-zone dimensions and pipe spacing
        </span>
      </div>
      {zoneSummaries.length === 0 ? (
        <div className="panel-empty">{emptyMessage}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="right">Width</th>
              <th align="right">Height</th>
              <th align="right">Pipe spacing (m)</th>
              {(onClone || onDelete || onExpand) && <th align="right"></th>}
            </tr>
          </thead>
          <tbody>
            {zoneSummaries.map((z) => {
              const pipeSpacing = pipeSpacingByZoneId[z.id] ?? defaultPipeSpacingM;
              return (
              <tr key={z.id}>
                <td>{z.name}</td>
                <td align="right">
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={
                      editingKey === `${z.id}-width`
                        ? editingValue
                        : Number.isFinite(z.width)
                          ? z.width.toFixed(2)
                          : ""
                    }
                    onFocus={() => {
                      setEditingKey(`${z.id}-width`);
                      setEditingValue(Number.isFinite(z.width) ? z.width.toFixed(2) : "");
                    }}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      if (editingKey === `${z.id}-width`) setEditingValue(e.target.value);
                    }}
                    onBlur={() => {
                      if (editingKey === `${z.id}-width`) {
                        const n = Number(editingValue);
                        if (Number.isFinite(n) && n >= 0) onDimensionChange(z.id, "width", n);
                        setEditingKey(null);
                      }
                    }}
                    style={{ width: 64 }}
                  />
                </td>
                <td align="right">
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={
                      editingKey === `${z.id}-height`
                        ? editingValue
                        : Number.isFinite(z.height)
                          ? z.height.toFixed(2)
                          : ""
                    }
                    onFocus={() => {
                      setEditingKey(`${z.id}-height`);
                      setEditingValue(Number.isFinite(z.height) ? z.height.toFixed(2) : "");
                    }}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      if (editingKey === `${z.id}-height`) setEditingValue(e.target.value);
                    }}
                    onBlur={() => {
                      if (editingKey === `${z.id}-height`) {
                        const n = Number(editingValue);
                        if (Number.isFinite(n) && n >= 0) onDimensionChange(z.id, "height", n);
                        setEditingKey(null);
                      }
                    }}
                    style={{ width: 64 }}
                  />
                </td>
                <td align="right">
                  <input
                    type="number"
                    min={0.01}
                    step={0.01}
                    value={
                      editingKey === `${z.id}-pipe`
                        ? editingValue
                        : Number.isFinite(pipeSpacing)
                          ? pipeSpacing.toFixed(2)
                          : ""
                    }
                    onFocus={() => {
                      setEditingKey(`${z.id}-pipe`);
                      setEditingValue(Number.isFinite(pipeSpacing) ? pipeSpacing.toFixed(2) : "");
                    }}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      if (editingKey === `${z.id}-pipe`) setEditingValue(e.target.value);
                    }}
                    onBlur={() => {
                      if (editingKey === `${z.id}-pipe`) {
                        const v = Number(editingValue);
                        if (Number.isFinite(v) && v > 0) onPipeSpacingChange(z.id, v);
                        setEditingKey(null);
                      }
                    }}
                    style={{ width: 72 }}
                    title="Pipe spacing for this zone"
                  />
                </td>
                {(onClone || onDelete || onExpand) && (
                  <td align="right">
                    <ActionsMenu
                      title="Zone actions"
                      items={[
                        ...(onClone
                          ? [{ label: "Clone", onClick: () => onClone(z.id) }]
                          : []),
                        ...(onExpand
                          ? [
                              {
                                label: "Expand",
                                onClick: () => onExpand(z.id),
                                disabled: !canExpand || !canExpand(z.id)
                              }
                            ]
                          : []),
                        ...(onDelete
                          ? [{ label: "Delete", onClick: () => onDelete(z.id), danger: true }]
                          : [])
                      ]}
                    />
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {draft != null && onDraftDimensionChange && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #eee" }}>
          <div className="panel-title">
            <span>Draft zone dimensions</span>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: 8 }}>
            <label>
              <span style={{ marginRight: 4 }}>Width (m)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={draft.width}
                onChange={(e) =>
                  onDraftDimensionChange("width", Number(e.target.value))
                }
                style={{ width: 80 }}
              />
            </label>
            <label>
              <span style={{ marginRight: 4 }}>Height (m)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={draft.height}
                onChange={(e) =>
                  onDraftDimensionChange("height", Number(e.target.value))
                }
                style={{ width: 80 }}
              />
            </label>
          </div>
          <div className="panel-empty">{cancelHint}</div>
        </div>
      )}
    </div>
  );
};
