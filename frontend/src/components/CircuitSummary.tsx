import React from "react";

type Point = { x: number; y: number };

type CircuitRow = {
  id: string;
  name: string;
  lengthM: number;
  roomId?: string;
  roomName?: string;
  zoneId?: string;
  zoneName?: string;
  subzoneIndex?: number | null;
};

type ManifoldConnection = {
  circuitId: string;
  points: Point[];
};

function polylineLengthM(points: Point[]): number {
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

type Props = {
  circuits: CircuitRow[];
  manifoldConnections?: ManifoldConnection[];
};

function totalLengthWithConnections(
  circuits: CircuitRow[],
  manifoldConnections: ManifoldConnection[]
): number {
  const connectionLengthByCircuitId: Record<string, number> = {};
  manifoldConnections.forEach((conn) => {
    connectionLengthByCircuitId[conn.circuitId] = polylineLengthM(conn.points);
  });
  const totalLengthM = (c: CircuitRow) =>
    c.lengthM + (connectionLengthByCircuitId[c.id] ?? 0);
  return circuits.reduce((sum, c) => sum + totalLengthM(c), 0);
}

export const CircuitsTotalsCard: React.FC<Props> = ({
  circuits,
  manifoldConnections = []
}) => {
  if (circuits.length === 0) return null;
  const totalLength = totalLengthWithConnections(circuits, manifoldConnections);
  return (
    <div className="panel circuits-totals-card">
      <div className="circuits-totals-card__row">
        <span><strong>Total circuits:</strong> {circuits.length}</span>
        <span><strong>Total length:</strong> {totalLength.toFixed(1)} m</span>
      </div>
    </div>
  );
};

export const CircuitSummary: React.FC<Props> = ({
  circuits,
  manifoldConnections = []
}) => {
  const connectionLengthByCircuitId: Record<string, number> = {};
  manifoldConnections.forEach((conn) => {
    connectionLengthByCircuitId[conn.circuitId] = polylineLengthM(conn.points);
  });
  const totalLengthM = (c: CircuitRow) =>
    c.lengthM + (connectionLengthByCircuitId[c.id] ?? 0);

  // Group circuits by zone, then by subzone for "Subzones per zone" section
  const zonesWithSubzones = circuits.reduce<
    Record<string, { zoneName: string; subzones: Map<number, CircuitRow[]> }>
  >(
    (acc, c) => {
      const zId = c.zoneId ?? c.zoneName ?? "unknown";
      const zName = c.zoneName ?? c.zoneId ?? "Unknown";
      const subIdx = c.subzoneIndex ?? 0;
      if (!acc[zId]) {
        acc[zId] = { zoneName: zName, subzones: new Map() };
      }
      const subzones = acc[zId].subzones;
      if (!subzones.has(subIdx)) {
        subzones.set(subIdx, []);
      }
      subzones.get(subIdx)!.push(c);
      return acc;
    },
    {}
  );

  return (
    <div>
      <div className="panel-title">
        <span>Circuits</span>
        <span className="panel-subtitle">Lengths per circuit and per room</span>
      </div>
      {circuits.length === 0 ? (
        <div className="panel-empty">No circuits calculated yet.</div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th align="left">Circuit</th>
                <th align="left">Room</th>
                <th align="left">Subzone</th>
                <th align="right">Length (m)</th>
              </tr>
            </thead>
            <tbody>
              {circuits.map((c, i) => (
                <tr key={c.id ? `${c.id}-${i}` : `circuit-${i}`}>
                  <td>{c.name}</td>
                  <td>{c.roomName ?? "—"}</td>
                  <td>
                    {c.subzoneIndex != null ? String(c.subzoneIndex + 1) : "—"}
                  </td>
                  <td align="right">{totalLengthM(c).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12 }}>
            <div className="panel-title">
              <span>Circuits per room</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th align="left">Room</th>
                  <th align="right"># Circuits</th>
                  <th align="right">Total length (m)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(
                  circuits.reduce<
                    Record<string, { name: string; count: number; totalLengthM: number }>
                  >(
                    (acc, c) => {
                      const key = c.roomId ?? c.roomName ?? "unknown";
                      const name = c.roomName ?? c.roomId ?? "Unknown";
                      if (!acc[key]) {
                        acc[key] = { name, count: 0, totalLengthM: 0 };
                      }
                      acc[key].count += 1;
                      acc[key].totalLengthM += totalLengthM(c);
                      return acc;
                    },
                    {}
                  )
                ).map(([key, value]) => (
                  <tr key={key}>
                    <td>{value.name}</td>
                    <td align="right">{value.count}</td>
                    <td align="right">{value.totalLengthM.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="panel-title">
              <span>Subzones per zone</span>
            </div>
            {Object.entries(zonesWithSubzones).map(([zoneId, { zoneName, subzones }]) => (
              <div key={zoneId} style={{ marginBottom: 8 }}>
                <strong>{zoneName}</strong>
                {Array.from(subzones.entries())
                  .sort((a, b) => a[0] - b[0])
                  .map(([subIdx, subCircuits]) => (
                    <div key={subIdx} style={{ marginLeft: 12, marginTop: 4 }}>
                      Subzone {subIdx + 1}:{" "}
                      {subCircuits
                        .map((c) => `${c.name} (${totalLengthM(c).toFixed(1)} m)`)
                        .join(", ")}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

