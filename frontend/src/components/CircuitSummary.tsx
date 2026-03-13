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
  /** Layout algorithm used: spiral or meander */
  algorithm?: "spiral" | "meander";
  /** Set when showing combined all-floors view */
  floorName?: string;
};

type ManifoldConnection = {
  circuitId: string;
  manifoldId?: string;
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

type ManifoldItem = { id: string; name?: string };

type Props = {
  circuits: CircuitRow[];
  manifoldConnections?: ManifoldConnection[];
  /** Manifolds on this floor; used for per-manifold totals. */
  manifolds?: ManifoldItem[];
  /** Pipe roll length in meters; used for roll assignment and total rolls. */
  pipeRollLengthM?: number;
};

/** Extra meters to leave on each roll (tolerance). Require circuit_len + PIPE_ROLL_TOLERANCE_M <= remaining to assign. */
const PIPE_ROLL_TOLERANCE_M = 3;

type RollAssignment = {
  totalRolls: number;
  rollByCircuitId: Record<string, number>;
  rollCumulativeLengthByCircuitId: Record<string, number>;
  wasteM: number;
};

/** Total length for a circuit: in-zone + 2× connection stub. */
function circuitTotalLengthM(
  c: CircuitRow,
  connectionLengthByCircuitId: Record<string, number>
): number {
  return c.lengthM + 2 * (connectionLengthByCircuitId[c.id] ?? 0);
}

/** First-fit in given order: fill current roll while circuit fits; when current roll is full, scan existing rolls for a gap; only then open a new roll. Uses in-zone + 2× connection stub. */
function assignFirstFit(
  circuits: CircuitRow[],
  rollLengthM: number,
  connectionLengthByCircuitId: Record<string, number>
): RollAssignment {
  const rollByCircuitId: Record<string, number> = {};
  const rollCumulativeLengthByCircuitId: Record<string, number> = {};
  if (circuits.length === 0 || rollLengthM <= 0) {
    return { totalRolls: 0, rollByCircuitId, rollCumulativeLengthByCircuitId, wasteM: 0 };
  }
  /** Per roll: remaining length. */
  const rollRemaining: number[] = [];
  /** Per roll: used length (for cumulative display). */
  const rollUsed: number[] = [];
  /** Index of the roll we're currently filling (prefer this before scanning others). */
  let currentRollIndex = -1;
  let totalUsed = 0;
  for (const c of circuits) {
    const len = circuitTotalLengthM(c, connectionLengthByCircuitId);
    totalUsed += len;
    const required = len + PIPE_ROLL_TOLERANCE_M;
    let assigned = false;
    // Prefer current roll if it has space
    if (currentRollIndex >= 0 && rollRemaining[currentRollIndex] >= required) {
      const i = currentRollIndex;
      rollRemaining[i] -= len;
      rollUsed[i] += len;
      rollByCircuitId[c.id] = i + 1;
      rollCumulativeLengthByCircuitId[c.id] = rollUsed[i];
      assigned = true;
    }
    // When current roll is full (or no current roll), scan existing rolls for a gap
    if (!assigned) {
      for (let i = 0; i < rollRemaining.length; i++) {
        if (rollRemaining[i] >= required) {
          rollRemaining[i] -= len;
          rollUsed[i] += len;
          rollByCircuitId[c.id] = i + 1;
          rollCumulativeLengthByCircuitId[c.id] = rollUsed[i];
          assigned = true;
          break;
        }
      }
    }
    // Only if no existing roll fits: open a new roll and make it current
    if (!assigned) {
      const newIdx = rollRemaining.length;
      rollRemaining.push(rollLengthM - len);
      rollUsed.push(len);
      rollByCircuitId[c.id] = newIdx + 1;
      rollCumulativeLengthByCircuitId[c.id] = len;
      currentRollIndex = newIdx;
    }
  }
  const totalRolls = rollRemaining.length;
  const wasteM = totalRolls * rollLengthM - totalUsed;
  return { totalRolls, rollByCircuitId, rollCumulativeLengthByCircuitId, wasteM };
}

/** Best-fit decreasing: sort by total length descending, then assign each to the roll with smallest remaining that fits. Uses in-zone + 2× connection stub. */
function assignBFD(
  circuits: CircuitRow[],
  rollLengthM: number,
  connectionLengthByCircuitId: Record<string, number>
): RollAssignment {
  const rollByCircuitId: Record<string, number> = {};
  const rollCumulativeLengthByCircuitId: Record<string, number> = {};
  if (circuits.length === 0 || rollLengthM <= 0) {
    return { totalRolls: 0, rollByCircuitId, rollCumulativeLengthByCircuitId, wasteM: 0 };
  }
  const totalLen = (c: CircuitRow) => circuitTotalLengthM(c, connectionLengthByCircuitId);
  const sorted = [...circuits].sort((a, b) => totalLen(b) - totalLen(a));
  /** Rolls: index 0 = roll 1; value = remaining length on that roll. */
  const rollRemaining: number[] = [];
  /** Used length per roll (for cumulative display). */
  const rollUsed: number[] = [];
  let totalUsed = 0;
  for (const c of sorted) {
    const len = totalLen(c);
    totalUsed += len;
    const required = len + PIPE_ROLL_TOLERANCE_M;
    let bestIdx = -1;
    let bestRemaining = Infinity;
    for (let i = 0; i < rollRemaining.length; i++) {
      if (rollRemaining[i] >= required && rollRemaining[i] < bestRemaining) {
        bestRemaining = rollRemaining[i];
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      rollRemaining[bestIdx] -= len;
      rollUsed[bestIdx] += len;
      const rollNum = bestIdx + 1;
      rollByCircuitId[c.id] = rollNum;
      rollCumulativeLengthByCircuitId[c.id] = rollUsed[bestIdx];
    } else {
      const newIdx = rollRemaining.length;
      rollRemaining.push(rollLengthM - len);
      rollUsed.push(len);
      rollByCircuitId[c.id] = newIdx + 1;
      rollCumulativeLengthByCircuitId[c.id] = len;
    }
  }
  const totalRolls = rollRemaining.length;
  const wasteM = totalRolls * rollLengthM - totalUsed;
  return { totalRolls, rollByCircuitId, rollCumulativeLengthByCircuitId, wasteM };
}

/** Per-roll waste in meters (index 0 = roll 1). */
function getWastePerRoll(
  circuits: CircuitRow[],
  assignment: RollAssignment,
  rollLengthM: number
): number[] {
  const usedPerRoll: number[] = [];
  for (const c of circuits) {
    const r = assignment.rollByCircuitId[c.id];
    if (r == null) continue;
    const cum = assignment.rollCumulativeLengthByCircuitId[c.id] ?? 0;
    const idx = r - 1;
    usedPerRoll[idx] = Math.max(usedPerRoll[idx] ?? 0, cum);
  }
  return Array.from(
    { length: assignment.totalRolls },
    (_, i) => rollLengthM - (usedPerRoll[i] ?? 0)
  );
}

function totalLengthWithConnections(
  circuits: CircuitRow[],
  manifoldConnections: ManifoldConnection[]
): number {
  const connectionLengthByCircuitId: Record<string, number> = {};
  manifoldConnections.forEach((conn) => {
    connectionLengthByCircuitId[conn.circuitId] = polylineLengthM(conn.points);
  });
  const totalLengthM = (c: CircuitRow) =>
    c.lengthM + 2 * (connectionLengthByCircuitId[c.id] ?? 0);
  return circuits.reduce((sum, c) => sum + totalLengthM(c), 0);
}

export const CircuitsTotalsCard: React.FC<Props> = ({
  circuits,
  manifoldConnections = [],
  manifolds = [],
  pipeRollLengthM = 200
}) => {
  if (circuits.length === 0) return null;
  const connectionLengthByCircuitId: Record<string, number> = {};
  manifoldConnections.forEach((conn) => {
    connectionLengthByCircuitId[conn.circuitId] = polylineLengthM(conn.points);
  });
  const totalLengthM = (c: CircuitRow) =>
    c.lengthM + 2 * (connectionLengthByCircuitId[c.id] ?? 0);
  const totalLength = circuits.reduce((sum, c) => sum + totalLengthM(c), 0);
  const firstFit = assignFirstFit(circuits, pipeRollLengthM, connectionLengthByCircuitId);
  const bfd = assignBFD(circuits, pipeRollLengthM, connectionLengthByCircuitId);
  const showBfd = bfd.totalRolls < firstFit.totalRolls;

  const circuitIdToManifoldId: Record<string, string> = {};
  manifoldConnections.forEach((conn) => {
    if (conn.manifoldId) circuitIdToManifoldId[conn.circuitId] = conn.manifoldId;
  });

  const perManifold: { manifoldId: string; label: string; count: number; lengthM: number }[] = [];
  for (const m of manifolds) {
    const circuitIds = Object.entries(circuitIdToManifoldId)
      .filter(([, mid]) => mid === m.id)
      .map(([cid]) => cid);
    const set = new Set(circuitIds);
    const list = circuits.filter((c) => set.has(c.id));
    const lengthM = list.reduce((sum, c) => sum + totalLengthM(c), 0);
    perManifold.push({
      manifoldId: m.id,
      label: m.name ?? m.id,
      count: list.length,
      lengthM
    });
  }
  const connectedIds = new Set(Object.keys(circuitIdToManifoldId));
  const unassignedCount = circuits.filter((c) => !connectedIds.has(c.id)).length;
  const unassignedLength = circuits
    .filter((c) => !connectedIds.has(c.id))
    .reduce((sum, c) => sum + totalLengthM(c), 0);
  const hasUnassigned = unassignedCount > 0;

  return (
    <div className="panel circuits-totals-card">
      <div className="circuits-totals-card__row">
        <span><strong>Total circuits:</strong> {circuits.length}</span>
        <span><strong>Total length:</strong> {totalLength.toFixed(1)} m</span>
      </div>
      <div className="circuits-totals-card__row" style={{ fontSize: "0.9rem" }}>
        <span><strong>First-fit:</strong> {firstFit.totalRolls} rolls, {firstFit.wasteM.toFixed(1)} m waste</span>
        {showBfd && (
          <span><strong>BFD:</strong> {bfd.totalRolls} rolls, {bfd.wasteM.toFixed(1)} m waste</span>
        )}
      </div>
      {(perManifold.some((p) => p.count > 0) || hasUnassigned) && (
        <div className="circuits-totals-card__per-manifold" style={{ marginTop: 8, fontSize: "0.85rem" }}>
          {perManifold.map((p) => (
            p.count > 0 ? (
              <div key={p.manifoldId} className="circuits-totals-card__row">
                <span>{p.label}:</span>
                <span>{p.count} circuits, {p.lengthM.toFixed(1)} m</span>
              </div>
            ) : null
          ))}
          {hasUnassigned && (
            <div className="circuits-totals-card__row">
              <span>No connection:</span>
              <span>{unassignedCount} circuits, {unassignedLength.toFixed(1)} m</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const CircuitSummary: React.FC<Props> = ({
  circuits,
  manifoldConnections = [],
  pipeRollLengthM = 200
}) => {
  const connectionLengthByCircuitId: Record<string, number> = {};
  manifoldConnections.forEach((conn) => {
    connectionLengthByCircuitId[conn.circuitId] = polylineLengthM(conn.points);
  });
  const totalLengthM = (c: CircuitRow) =>
    c.lengthM + 2 * (connectionLengthByCircuitId[c.id] ?? 0);
  const firstFit = assignFirstFit(circuits, pipeRollLengthM, connectionLengthByCircuitId);
  const bfd = assignBFD(circuits, pipeRollLengthM, connectionLengthByCircuitId);
  const firstFitWastePerRoll = getWastePerRoll(circuits, firstFit, pipeRollLengthM);
  const bfdWastePerRoll = getWastePerRoll(circuits, bfd, pipeRollLengthM);
  const showBfd = bfd.totalRolls < firstFit.totalRolls;

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
        <span className="panel-subtitle">Total length: in-zone (supply + return, pipe spacing × 2) + 2× stub</span>
      </div>
      {circuits.length === 0 ? (
        <div className="panel-empty">No circuits calculated yet.</div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th align="left">Circuit</th>
                {circuits.some((c) => c.floorName) && <th align="left">Floor</th>}
                <th align="left" className="panel-name-cell">Room</th>
                <th align="left">Subzone</th>
                <th align="left">Layout</th>
                <th align="right">Length (m)</th>
                <th align="right">Roll (First-fit)</th>
                {showBfd && <th align="right">Roll (BFD)</th>}
              </tr>
            </thead>
            <tbody>
              {circuits.map((c, i) => (
                <tr key={c.id ? `${c.id}-${i}` : `circuit-${i}`}>
                  <td>{c.name}</td>
                  {circuits.some((x) => x.floorName) && <td>{c.floorName ?? "—"}</td>}
                  <td>{c.roomName ?? "—"}</td>
                  <td>
                    {c.subzoneIndex != null ? String(c.subzoneIndex + 1) : "—"}
                  </td>
                  <td>{c.algorithm === "spiral" ? "Spiral" : c.algorithm === "meander" ? "Meander" : "—"}</td>
                  <td align="right">{totalLengthM(c).toFixed(1)}</td>
                  <td align="right">
                    {firstFit.rollByCircuitId[c.id] != null
                      ? `${firstFit.rollByCircuitId[c.id]} (${(firstFit.rollCumulativeLengthByCircuitId[c.id] ?? 0).toFixed(1)})`
                      : "—"}
                  </td>
                  {showBfd && (
                    <td align="right">
                      {bfd.rollByCircuitId[c.id] != null
                        ? `${bfd.rollByCircuitId[c.id]} (${(bfd.rollCumulativeLengthByCircuitId[c.id] ?? 0).toFixed(1)})`
                        : "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12 }}>
            <div className="panel-title">
              <span>Waste per roll</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th align="left">Roll</th>
                  <th align="right">First-fit waste (m)</th>
                  {showBfd && <th align="right">BFD waste (m)</th>}
                </tr>
              </thead>
              <tbody>
                {Array.from(
                  { length: showBfd ? Math.max(firstFit.totalRolls, bfd.totalRolls) : firstFit.totalRolls },
                  (_, i) => i + 1
                ).map((rollNum) => (
                  <tr key={rollNum}>
                    <td>{rollNum}</td>
                    <td align="right">
                      {rollNum <= firstFit.totalRolls
                        ? firstFitWastePerRoll[rollNum - 1]!.toFixed(1)
                        : "—"}
                    </td>
                    {showBfd && (
                      <td align="right">
                        {rollNum <= bfd.totalRolls
                          ? bfdWastePerRoll[rollNum - 1]!.toFixed(1)
                          : "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="panel-title">
              <span>Circuits per room</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th align="left" className="panel-name-cell">Room</th>
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

