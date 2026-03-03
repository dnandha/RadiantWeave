import React from "react";

export type DrawMode =
  | "cursor"
  | "create-room"
  | "create-zone"
  | "edit-rooms"
  | "edit-zones"
  | "manifold"
  | "move-manifold"
  | "add-connection"
  | "move-inlet";

const MODES: { value: DrawMode; label: string }[] = [
  { value: "cursor", label: "👆" },
  { value: "create-room", label: "Create rooms" },
  { value: "create-zone", label: "Create zones" },
  { value: "edit-rooms", label: "Edit rooms" },
  { value: "edit-zones", label: "Edit zones" },
  { value: "manifold", label: "Place manifold" },
  { value: "move-manifold", label: "Move manifold" },
  { value: "add-connection", label: "Add connection" },
  { value: "move-inlet", label: "Move inlet" }
];

type Props = {
  value: DrawMode;
  onChange: (mode: DrawMode) => void;
};

export const DrawModeButtons: React.FC<Props> = ({ value, onChange }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
    {MODES.map(({ value: modeValue, label }) => (
      <button
        key={modeValue}
        type="button"
        onClick={() => onChange(modeValue)}
        className={value === modeValue ? "mode-btn mode-btn--active" : "mode-btn"}
      >
        {label}
      </button>
    ))}
  </div>
);
