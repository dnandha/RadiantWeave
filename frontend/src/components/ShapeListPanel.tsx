import React, { ChangeEvent, useState } from "react";
import { ActionsMenu } from "./ActionsMenu";

export type ShapeSummary = {
  id: string;
  name: string;
  width: number;
  height: number;
};

type Props = {
  title: string;
  items: ShapeSummary[];
  emptyMessage: string;
  onDimensionChange: (id: string, field: "width" | "height", value: number) => void;
  onDelete?: (id: string) => void;
  draft?: { width: number; height: number } | null;
  onDraftDimensionChange?: (field: "width" | "height", value: number) => void;
  draftTitle?: string;
  cancelHint?: string;
};

export const ShapeListPanel: React.FC<Props> = ({
  title,
  items,
  emptyMessage,
  onDimensionChange,
  onDelete,
  draft,
  onDraftDimensionChange,
  draftTitle = "Draft dimensions",
  cancelHint = "Press Esc or “Cancel draft” to cancel."
}) => {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  return (
    <>
      <div>
        <div className="panel-title">
          <span>{title}</span>
        </div>
        {items.length === 0 ? (
          <div className="panel-empty">{emptyMessage}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th align="left">Name</th>
                <th align="right">Width</th>
                <th align="right">Height</th>
                {onDelete && <th align="right"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td align="right">
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={
                        editingKey === `${r.id}-width`
                          ? editingValue
                          : Number.isFinite(r.width)
                            ? r.width.toFixed(2)
                            : ""
                      }
                      onFocus={() => {
                        setEditingKey(`${r.id}-width`);
                        setEditingValue(Number.isFinite(r.width) ? r.width.toFixed(2) : "");
                      }}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        if (editingKey === `${r.id}-width`) setEditingValue(e.target.value);
                      }}
                      onBlur={() => {
                        if (editingKey === `${r.id}-width`) {
                          const n = Number(editingValue);
                          if (Number.isFinite(n) && n >= 0) onDimensionChange(r.id, "width", n);
                          setEditingKey(null);
                        }
                      }}
                      style={{ width: 80 }}
                    />
                  </td>
                  <td align="right">
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={
                        editingKey === `${r.id}-height`
                          ? editingValue
                          : Number.isFinite(r.height)
                            ? r.height.toFixed(2)
                            : ""
                      }
                      onFocus={() => {
                        setEditingKey(`${r.id}-height`);
                        setEditingValue(Number.isFinite(r.height) ? r.height.toFixed(2) : "");
                      }}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        if (editingKey === `${r.id}-height`) setEditingValue(e.target.value);
                      }}
                      onBlur={() => {
                        if (editingKey === `${r.id}-height`) {
                          const n = Number(editingValue);
                          if (Number.isFinite(n) && n >= 0) onDimensionChange(r.id, "height", n);
                          setEditingKey(null);
                        }
                      }}
                      style={{ width: 80 }}
                    />
                  </td>
                  {onDelete && (
                    <td align="right">
                      <ActionsMenu
                        title="Room actions"
                        items={[{ label: "Delete", onClick: () => onDelete(r.id), danger: true }]}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {draft != null && onDraftDimensionChange && (
        <div style={{ marginTop: 8 }}>
          <div className="panel-title">
            <span>{draftTitle}</span>
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
    </>
  );
};
