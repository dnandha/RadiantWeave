import React from "react";

type Zone = {
  id: string;
  name: string;
};

type Props = {
  zones: Zone[];
  onAddZone: () => void;
};

export const ZoneEditor: React.FC<Props> = ({ zones, onAddZone }) => {
  return (
    <div style={{ padding: "0.75rem", border: "1px solid #eee" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <strong>Zones</strong>
        <button type="button" className="btn-sm" onClick={onAddZone}>
          Add zone
        </button>
      </div>
      {zones.length === 0 ? (
        <div style={{ color: "#666" }}>No zones defined yet.</div>
      ) : (
        <ul>
          {zones.map((z) => (
            <li key={z.id}>{z.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

