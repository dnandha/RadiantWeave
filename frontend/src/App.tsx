import React, { ChangeEvent, useEffect, useRef, useState } from "react";
import { FloorplanCanvas, type FloorplanCanvasHandle } from "./components/FloorplanCanvas";
import { CircuitSummary, CircuitsTotalsCard } from "./components/CircuitSummary";
import { DrawModeButtons, type DrawMode } from "./components/DrawModeButtons";
import { HelpModal } from "./components/HelpModal";
import { ShapeListPanel, type ShapeSummary } from "./components/ShapeListPanel";
import { ZonesPanel } from "./components/ZonesPanel";
import "./App.css";

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

type CircuitPath = {
  id: string;
  points: Point[];
};

type Room = {
  id: string;
  name: string;
  points: Point[];
};

type Zone = {
  id: string;
  name: string;
  points: Point[];
  roomId?: string;
  /** Pipe spacing in meters; when set, overrides global default for this zone. */
  pipeSpacingM?: number;
};

type ManifoldConnection = {
  circuitId: string;
  /** Which manifold this connection goes to (optional for backward compat). */
  manifoldId?: string;
  points: Point[];
};

/** A manifold on a floor (position and optional name). */
type ManifoldItem = {
  id: string;
  position: Point;
  name?: string;
};

type Floor = {
  id: string;
  name: string;
  rooms: Room[];
  zones: Zone[];
  /** Multiple manifolds per floor. */
  manifolds: ManifoldItem[];
  manifoldConnections: ManifoldConnection[];
  circuitInletOverrides: Record<string, Point>;
  circuits: CircuitRow[];
  paths: CircuitPath[];
  /** Max circuit length in meters; used when calculating circuits for this floor. */
  maxCircuitLengthM?: number;
  /** Pipe roll length in meters; used for roll assignment. */
  pipeRollLengthM?: number;
};

type Layout = {
  pixelsPerMeter: number;
  currentFloorId?: string;
  floors: Floor[];
};

/** Keep only the first zone per id when loading; avoids duplicate zone IDs. */
function deduplicateZones(zones: Zone[]): Zone[] {
  const seen = new Set<string>();
  return zones.filter((z) => {
    if (seen.has(z.id)) return false;
    seen.add(z.id);
    return true;
  });
}

/** True if rect points are degenerate (all same point, zero area). */
function isDegenerateRect(points: Point[]): boolean {
  if (points.length < 4) return true;
  const p0 = points[0]!;
  return points.every((p) => p.x === p0.x && p.y === p0.y);
}

function addPoint(p: Point, delta: Point): Point {
  return { x: p.x + delta.x, y: p.y + delta.y };
}

/** Length of a polyline in meters (sum of segment lengths). */
function polylineLengthM(points: Point[]): number {
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

/** Snap a point to the only orthogonal option from `from`: either (from.x, to.y) or (to.x, from.y), whichever is closer to `to`. */
function snapToOrthogonal(from: Point, to: Point): Point {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return dx <= dy ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
}

/** Snap a point to a grid in meters (e.g. 0.005 for 5mm) so connection lines can run parallel at fixed spacing. */
function snapToGrid(p: Point, gridM: number): Point {
  return {
    x: Math.round(p.x / gridM) * gridM,
    y: Math.round(p.y / gridM) * gridM
  };
}

const CONNECTION_GRID_M = 0.05; /* 5cm – minimum spacing between connection lines */

/** Subzone rectangle (4 corners) for a zone split into n strips. Matches backend split_zone_into_subzones. */
function getSubzoneRect(zonePoints: Point[], subzoneIndex: number, n: number): Point[] {
  if (n <= 1 || zonePoints.length < 4) return zonePoints;
  const xs = zonePoints.map((p) => p.x);
  const ys = zonePoints.map((p) => p.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const bottom = Math.min(...ys);
  const top = Math.max(...ys);
  const w = right - left;
  const h = top - bottom;
  if (w <= 0 || h <= 0) return zonePoints;
  const i = Math.max(0, Math.min(subzoneIndex, n - 1));
  if (w >= h) {
    const x0 = left + (w * i) / n;
    const x1 = left + (w * (i + 1)) / n;
    return [
      { x: x0, y: bottom },
      { x: x1, y: bottom },
      { x: x1, y: top },
      { x: x0, y: top }
    ];
  }
  const y0 = bottom + (h * i) / n;
  const y1 = bottom + (h * (i + 1)) / n;
  return [
    { x: left, y: y0 },
    { x: right, y: y0 },
    { x: right, y: y1 },
    { x: left, y: y1 }
  ];
}

const defaultPixelsPerMeter = 50;
const LOCAL_STORAGE_KEY = "underfloor-heating-layout";

function newFloor(id: string, name: string): Floor {
  return {
    id,
    name,
    rooms: [],
    zones: [],
    manifolds: [],
    manifoldConnections: [],
    circuitInletOverrides: {},
    circuits: [],
    paths: [],
    maxCircuitLengthM: 60,
    pipeRollLengthM: 200
  };
}

export const App: React.FC = () => {
  const [pixelsPerMeter, setPixelsPerMeter] = useState<number>(defaultPixelsPerMeter);
  const [floors, setFloors] = useState<Floor[]>(() => [
    newFloor("floor-1", "Ground floor")
  ]);
  const [currentFloorId, setCurrentFloorId] = useState<string>("floor-1");
  const [draftRoom, setDraftRoom] = useState<Room | null>(null);
  const [draftZone, setDraftZone] = useState<Zone | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>("cursor");
  const [dragState, setDragState] = useState<
    | { type: "room"; id: string; startMouse: Point; originalPoints: Point[] }
    | { type: "zone"; id: string; startMouse: Point; originalPoints: Point[] }
    | null
  >(null);
  const [cornerDragState, setCornerDragState] = useState<{
    type: "room" | "zone";
    id: string;
    cornerIndex: number;
    startMouse: Point;
    originalPoints: Point[];
  } | null>(null);
  const [pipeSpacingM, setPipeSpacingM] = useState<number>(0.10);
  const canvasRef = useRef<FloorplanCanvasHandle>(null);
  const [connectionDrawing, setConnectionDrawing] = useState<{
    points: Point[];
    startCircuitId?: string;
    startManifoldId?: string;
  } | null>(null);
  const [draggingManifoldId, setDraggingManifoldId] = useState<string | null>(null);
  const lastCanvasClickTimeRef = useRef(0);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [editingFloor, setEditingFloor] = useState<{ id: string; name: string } | null>(null);
  const editingFloorInputRef = useRef<HTMLInputElement>(null);
  const [floorToDelete, setFloorToDelete] = useState<string | null>(null);
  const [circuitViewScope, setCircuitViewScope] = useState<"current-floor" | "all-floors">("current-floor");
  const [printMode, setPrintMode] = useState(false);

  const currentFloor = React.useMemo(
    () => floors.find((f) => f.id === currentFloorId) ?? floors[0]!,
    [floors, currentFloorId]
  );
  const rooms = currentFloor.rooms;
  const zones = currentFloor.zones;
  const manifolds = currentFloor.manifolds ?? [];
  const manifoldConnections = currentFloor.manifoldConnections;
  const circuitInletOverrides = currentFloor.circuitInletOverrides;
  const circuits = currentFloor.circuits;
  const paths = currentFloor.paths;

  const {
    displayCircuits,
    displayManifoldConnections,
    displayManifolds,
    displayPipeRollLengthM
  } = React.useMemo(() => {
    if (circuitViewScope !== "all-floors" || floors.length === 0) {
      return {
        displayCircuits: circuits,
        displayManifoldConnections: manifoldConnections,
        displayManifolds: manifolds,
        displayPipeRollLengthM: currentFloor.pipeRollLengthM ?? 200
      };
    }
    const combinedCircuits: (CircuitRow & { floorId?: string; floorName?: string })[] = floors.flatMap(
      (f) =>
        f.circuits.map((c) => ({
          ...c,
          id: `${f.id}-${c.id}`,
          floorId: f.id,
          floorName: f.name
        }))
    );
    const combinedManifoldConnections: ManifoldConnection[] = floors.flatMap((f) =>
      f.manifoldConnections.map((conn) => ({
        circuitId: `${f.id}-${conn.circuitId}`,
        manifoldId: conn.manifoldId != null ? `${f.id}-${conn.manifoldId}` : undefined,
        points: conn.points ?? []
      }))
    );
    const combinedManifolds: ManifoldItem[] = floors.flatMap((f) =>
      (f.manifolds ?? []).map((m) => ({
        id: `${f.id}-${m.id}`,
        position: m.position,
        name: m.name ?? `${f.name} manifold`
      }))
    );
    const rollM = floors[0]?.pipeRollLengthM ?? 200;
    return {
      displayCircuits: combinedCircuits,
      displayManifoldConnections: combinedManifoldConnections,
      displayManifolds: combinedManifolds,
      displayPipeRollLengthM: rollM
    };
  }, [
    circuitViewScope,
    floors,
    circuits,
    manifoldConnections,
    manifolds,
    currentFloor.pipeRollLengthM
  ]);

  const printData = React.useMemo(() => {
    if (!printMode || floors.length === 0) return null;

    const combinedCircuits: (CircuitRow & { floorId?: string; floorName?: string })[] = floors.flatMap(
      (f) =>
        f.circuits.map((c) => ({
          ...c,
          id: `${f.id}-${c.id}`,
          floorId: f.id,
          floorName: f.name
        }))
    );
    const combinedManifoldConnections: ManifoldConnection[] = floors.flatMap((f) =>
      f.manifoldConnections.map((conn) => ({
        circuitId: `${f.id}-${conn.circuitId}`,
        manifoldId: conn.manifoldId != null ? `${f.id}-${conn.manifoldId}` : undefined,
        points: conn.points ?? []
      }))
    );
    const combinedManifolds: ManifoldItem[] = floors.flatMap((f) =>
      (f.manifolds ?? []).map((m) => ({
        id: `${f.id}-${m.id}`,
        position: m.position,
        name: m.name ?? `${f.name} manifold`
      }))
    );
    const rollM = floors[0]?.pipeRollLengthM ?? 200;

    return {
      combinedCircuits,
      combinedManifoldConnections,
      combinedManifolds,
      rollM
    };
  }, [printMode, floors]);

  const updateCurrentFloor = React.useCallback(
    (patch: Partial<Floor>) => {
      setFloors((prev) =>
        prev.map((f) => (f.id !== currentFloorId ? f : { ...f, ...patch }))
      );
    },
    [currentFloorId]
  );

  React.useEffect(() => {
    if (editingFloor) editingFloorInputRef.current?.focus();
  }, [editingFloor]);

  // Remove connections that don't have a valid inlet (circuit exists) or don't reach a manifold.
  React.useEffect(() => {
    const circuitIds = new Set(circuits.map((c) => c.id));
    const manifoldIds = new Set(manifolds.map((m) => m.id));
    const MANIFOLD_HIT_M = 0.15;
    const nearAnyManifold = (p: Point) =>
      manifolds.some((m) => Math.hypot(p.x - m.position.x, p.y - m.position.y) <= MANIFOLD_HIT_M);
    const filtered = manifoldConnections.filter((conn) => {
      if (!circuitIds.has(conn.circuitId)) return false;
      if (conn.manifoldId != null && !manifoldIds.has(conn.manifoldId)) return false;
      if (!conn.points?.length || conn.points.length < 2) return false;
      if (manifolds.length > 0) {
        const first = conn.points[0]!;
        const last = conn.points[conn.points.length - 1]!;
        if (conn.manifoldId) {
          const m = manifolds.find((x) => x.id === conn.manifoldId);
          if (!m) return false;
          const near = (p: Point) => Math.hypot(p.x - m.position.x, p.y - m.position.y) <= MANIFOLD_HIT_M;
          if (!near(first) && !near(last)) return false;
        } else if (!nearAnyManifold(first) && !nearAnyManifold(last)) return false;
      }
      return true;
    });
    const unchanged =
      manifoldConnections.length === filtered.length &&
      filtered.every((c, i) => manifoldConnections[i]?.circuitId === c.circuitId);
    if (!unchanged) {
      setManifoldConnections(filtered);
    }
  }, [circuits, manifolds, manifoldConnections]);

  const commitFloorRename = (id: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed) {
      setFloors((prev) =>
        prev.map((f) => (f.id === id ? { ...f, name: trimmed } : f))
      );
    }
    setEditingFloor(null);
  };

  const applyOffsetToCurrentFloor = React.useCallback(
    (offset: Point) => {
      setFloors((prev) =>
        prev.map((f) => {
          if (f.id !== currentFloorId) return f;
          return {
            ...f,
            rooms: f.rooms.map((r) => ({
              ...r,
              points: r.points.map((p) => addPoint(p, offset))
            })),
            zones: f.zones.map((z) => ({
              ...z,
              points: z.points.map((p) => addPoint(p, offset))
            })),
            manifolds: (f.manifolds ?? []).map((m) => ({
              ...m,
              position: addPoint(m.position, offset)
            })),
            manifoldConnections: f.manifoldConnections.map((c) => ({
              ...c,
              points: c.points.map((p) => addPoint(p, offset))
            })),
            circuitInletOverrides: Object.fromEntries(
              Object.entries(f.circuitInletOverrides).map(([id, p]) => [
                id,
                addPoint(p, offset)
              ])
            ),
            paths: f.paths.map((path) => ({
              ...path,
              points: path.points.map((p) => addPoint(p, offset))
            }))
          };
        })
      );
    },
    [currentFloorId]
  );

  const handlePrint = React.useCallback(() => {
    if (typeof window === "undefined") return;
    setPrintMode(true);
    window.setTimeout(() => {
      window.print();
    }, 50);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleAfterPrint = () => {
      setPrintMode(false);
    };
    window.addEventListener("afterprint", handleAfterPrint);
    return () => {
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, []);

  const handleCenterPlan = () => {
    const result = canvasRef.current?.getCenterPlanOffset();
    if (result) {
      applyOffsetToCurrentFloor(result.offset);
      canvasRef.current?.resetPan();
      setDraftRoom((current) => {
        if (current) {
          setRooms((prev) =>
            prev.filter((r) => r.id !== current.id || !isDegenerateRect(r.points))
          );
        }
        return null;
      });
      setDraftZone((current) => {
        if (current) {
          setZones((prev) =>
            prev.filter((z) => z.id !== current.id || !isDegenerateRect(z.points))
          );
        }
        return null;
      });
      setConnectionDrawing(null);
    }
  };

  const setRooms = (updater: Room[] | ((prev: Room[]) => Room[])) => {
    updateCurrentFloor({
      rooms: typeof updater === "function" ? updater(rooms) : updater
    });
  };
  const setZones = (updater: Zone[] | ((prev: Zone[]) => Zone[])) => {
    updateCurrentFloor({
      zones: typeof updater === "function" ? updater(zones) : updater
    });
  };
  const setManifolds = (updater: ManifoldItem[] | ((prev: ManifoldItem[]) => ManifoldItem[])) => {
    updateCurrentFloor({
      manifolds: typeof updater === "function" ? updater(manifolds) : updater
    });
  };
  const addManifold = (position: Point) => {
    setManifolds((prev) => [
      ...prev,
      { id: `manifold-${Date.now()}`, position, name: "Manifold" }
    ]);
  };
  const updateManifold = (id: string, patch: Partial<ManifoldItem>) => {
    setManifolds((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m))
    );
  };
  const removeManifold = (id: string) => {
    setManifolds((prev) => prev.filter((m) => m.id !== id));
    setManifoldConnections((prev) => prev.filter((c) => c.manifoldId !== id));
  };
  const setManifoldConnections = (updater: ManifoldConnection[] | ((prev: ManifoldConnection[]) => ManifoldConnection[])) => {
    updateCurrentFloor({
      manifoldConnections:
        typeof updater === "function" ? updater(manifoldConnections) : updater
    });
  };
  const setCircuitInletOverrides = (
    updater:
      | Record<string, Point>
      | ((prev: Record<string, Point>) => Record<string, Point>)
  ) => {
    updateCurrentFloor({
      circuitInletOverrides:
        typeof updater === "function"
          ? updater(circuitInletOverrides)
          : updater
    });
  };
  const setCircuits = (updater: CircuitRow[] | ((prev: CircuitRow[]) => CircuitRow[])) => {
    updateCurrentFloor({
      circuits: typeof updater === "function" ? updater(circuits) : updater
    });
  };
  const setPaths = (updater: CircuitPath[] | ((prev: CircuitPath[]) => CircuitPath[])) => {
    updateCurrentFloor({
      paths: typeof updater === "function" ? updater(paths) : updater
    });
  };

  useEffect(() => {
    // Restore layout from localStorage on first mount.
    try {
      const raw =
        typeof window !== "undefined"
          ? window.localStorage.getItem(LOCAL_STORAGE_KEY)
          : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Layout & {
          rooms?: Room[];
          zones?: Zone[];
          manifoldPosition?: Point | null;
          manifoldConnections?: ManifoldConnection[];
          circuitInletOverrides?: Record<string, Point>;
        };
        if (!parsed) return;
        setPixelsPerMeter(parsed.pixelsPerMeter || defaultPixelsPerMeter);
        if (Array.isArray(parsed.floors) && parsed.floors.length > 0) {
          setFloors(
            parsed.floors.map((f: any) => ({
              id: f.id ?? `floor-${Date.now()}`,
              name: f.name ?? "Floor",
              rooms: Array.isArray(f.rooms) ? f.rooms : [],
              zones: deduplicateZones(Array.isArray(f.zones) ? f.zones : []),
              manifolds: Array.isArray(f.manifolds)
                ? f.manifolds.map((m: any) => ({
                    id: m.id ?? `manifold-${Date.now()}`,
                    position: m.position ?? { x: 0, y: 0 },
                    name: m.name
                  }))
                : f.manifoldPosition
                  ? [{ id: "manifold-1", position: f.manifoldPosition, name: "Manifold" }]
                  : [],
              manifoldConnections: Array.isArray(f.manifoldConnections)
                ? f.manifoldConnections.map((c: any) => ({
                    circuitId: c.circuitId,
                    manifoldId: c.manifoldId,
                    points: c.points ?? []
                  }))
                : [],
              circuitInletOverrides:
                f.circuitInletOverrides && typeof f.circuitInletOverrides === "object"
                  ? f.circuitInletOverrides
                  : {},
              circuits: Array.isArray(f.circuits) ? f.circuits : [],
              paths: Array.isArray(f.paths) ? f.paths : [],
              maxCircuitLengthM: typeof f.maxCircuitLengthM === "number" ? f.maxCircuitLengthM : 60,
              pipeRollLengthM: typeof f.pipeRollLengthM === "number" ? f.pipeRollLengthM : 200
            }))
          );
          if (parsed.currentFloorId && parsed.floors.some((f: any) => f.id === parsed.currentFloorId)) {
            setCurrentFloorId(parsed.currentFloorId);
          } else {
            setCurrentFloorId(parsed.floors[0].id);
          }
        } else if (Array.isArray(parsed.rooms)) {
          // Legacy layout (no floors): assign to current floor (initial load = floor-1)
          const currentId = "floor-1";
          const legacyFloorPatch = {
            rooms: parsed.rooms,
            zones: deduplicateZones(Array.isArray(parsed.zones) ? parsed.zones : []),
            manifolds: parsed.manifoldPosition
              ? [{ id: "manifold-1", position: parsed.manifoldPosition, name: "Manifold" }]
              : [],
            manifoldConnections: Array.isArray(parsed.manifoldConnections)
              ? parsed.manifoldConnections.map((c: any) => ({
                  circuitId: c.circuitId,
                  manifoldId: c.manifoldId,
                  points: c.points ?? []
                }))
              : [],
            circuitInletOverrides:
              parsed.circuitInletOverrides && typeof parsed.circuitInletOverrides === "object"
                ? parsed.circuitInletOverrides
                : {},
            circuits: [] as CircuitRow[],
            paths: [] as CircuitPath[],
            maxCircuitLengthM: typeof (parsed as any).maxCircuitLengthM === "number" ? (parsed as any).maxCircuitLengthM : 60,
            pipeRollLengthM: typeof (parsed as any).pipeRollLengthM === "number" ? (parsed as any).pipeRollLengthM : 200
          };
          setFloors((prev) =>
            prev.some((f) => f.id === currentId)
              ? prev.map((f) => (f.id === currentId ? { ...f, ...legacyFloorPatch } : f))
              : [...prev, { id: currentId, name: "Ground floor", ...legacyFloorPatch }]
          );
          setCurrentFloorId(currentId);
        }
      }
    } catch {
      // ignore malformed storage
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraftRoom((current) => {
          if (current) {
            setRooms((prev) =>
              prev.filter((r) => r.id !== current.id || !isDegenerateRect(r.points))
            );
          }
          return null;
        });
        setDraftZone((current) => {
          if (current) {
            setZones((prev) =>
              prev.filter((z) => z.id !== current.id || !isDegenerateRect(z.points))
            );
          }
          return null;
        });
        setConnectionDrawing(null);
        setDragState(null);
        setCornerDragState(null);
      }
    };
    const handleMouseUp = () => {
      setDragState(null);
      setCornerDragState(null);
      setDraggingManifoldId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      const layout: Layout = {
        pixelsPerMeter,
        currentFloorId,
        floors
      };
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // ignore storage errors (e.g. quota, private mode)
    }
  }, [pixelsPerMeter, currentFloorId, floors]);

  useEffect(() => {
    if (drawMode !== "add-connection") setConnectionDrawing(null);
  }, [drawMode]);

  const findContainingRoomId = (point: Point): string | undefined => {
    for (const room of rooms) {
      if (room.points.length === 0) continue;
      const xs = room.points.map((p) => p.x);
      const ys = room.points.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      if (
        point.x >= minX &&
        point.x <= maxX &&
        point.y >= minY &&
        point.y <= maxY
      ) {
        return room.id;
      }
    }
    return undefined;
  };

  /** Rebuild axis-aligned rectangle from four corners (indices 0–3); corner at cornerIndex is set to newPoint.
   * The opposite corner stays fixed, so you can both grow and shrink the rectangle (and flip orientation).
   */
  const updateRectCorner = (
    points: Point[],
    cornerIndex: number,
    newPoint: Point
  ): Point[] => {
    if (points.length < 4) return points;
    // Opposite corner index in a 4-corner loop (0-1-2-3).
    const oppositeIndex = (cornerIndex + 2) % 4;
    const opposite = points[oppositeIndex];
    const x1 = Math.min(newPoint.x, opposite.x);
    const x2 = Math.max(newPoint.x, opposite.x);
    const y1 = Math.min(newPoint.y, opposite.y);
    const y2 = Math.max(newPoint.y, opposite.y);
    return [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
      { x: x1, y: y1 }
    ];
  };

  const handleConnectionStartAtManifold = (manifoldId: string, point: Point) => {
    setConnectionDrawing({ points: [point], startManifoldId: manifoldId });
  };

  const handleConnectionStartAtInlet = (circuitId: string, point: Point) => {
    setConnectionDrawing({ points: [point], startCircuitId: circuitId });
  };

  const handleFinishConnectionAtManifold = (manifoldId: string) => {
    if (!connectionDrawing || connectionDrawing.points.length < 1) return;
    const circuitId = connectionDrawing.startCircuitId;
    if (!circuitId) return;
    const manifold = manifolds.find((m) => m.id === manifoldId);
    if (!manifold) return;
    const last = connectionDrawing.points[connectionDrawing.points.length - 1]!;
    const points: Point[] = [...connectionDrawing.points];
    if (last.x !== manifold.position.x || last.y !== manifold.position.y) {
      points.push(snapToOrthogonal(last, manifold.position));
    }
    points.push(manifold.position);
    setManifoldConnections((prev) =>
      prev.filter((c) => c.circuitId !== circuitId).concat({
        circuitId,
        manifoldId,
        points
      })
    );
    setConnectionDrawing(null);
  };

  const handleConnectionFinishAtInlet = (circuitId: string, point: Point) => {
    if (!connectionDrawing || connectionDrawing.points.length < 1) return;
    const last = connectionDrawing.points[connectionDrawing.points.length - 1]!;
    const points: Point[] = [...connectionDrawing.points];
    if (last.x !== point.x || last.y !== point.y) {
      points.push(snapToOrthogonal(last, point));
    }
    points.push(point);
    setManifoldConnections((prev) =>
      prev.filter((c) => c.circuitId !== circuitId).concat({ circuitId, points })
    );
    setConnectionDrawing(null);
  };

  const handleConnectionAddPoint = (pointMeters: Point) => {
    if (!connectionDrawing || connectionDrawing.points.length < 1) return;
    const last = connectionDrawing.points[connectionDrawing.points.length - 1]!;
    const toAdd = snapToGrid(snapToOrthogonal(last, pointMeters), CONNECTION_GRID_M);
    setConnectionDrawing({
      ...connectionDrawing,
      points: [...connectionDrawing.points, toAdd]
    });
  };

  const handleInletOverrideChange = (circuitId: string, point: Point) => {
    setCircuitInletOverrides((prev) => ({ ...prev, [circuitId]: point }));
    setManifoldConnections((prev) =>
      prev.map((c) =>
        c.circuitId === circuitId && c.points.length > 0
          ? { ...c, points: [...c.points.slice(0, -1), point] }
          : c
      )
    );
  };

  const circuitIdToZoneId = React.useMemo(() => {
    const map: Record<string, string> = {};
    circuits.forEach((c) => {
      if (c.zoneId) map[c.id] = c.zoneId;
    });
    return map;
  }, [circuits]);

  /** Per-circuit rectangle (4 points) to constrain inlet to: subzone border when circuit has a subzone, else full zone. */
  const circuitIdToInletConstraintRect = React.useMemo(() => {
    const map: Record<string, Point[]> = {};
    circuits.forEach((c) => {
      if (!c.zoneId) return;
      const zone = zones.find((z) => z.id === c.zoneId);
      if (!zone || zone.points.length < 4) return;
      const zonePoints = zone.points.slice(0, 4);
      const circuitsInZone = circuits.filter((c2) => c2.zoneId === c.zoneId);
      const n = circuitsInZone.length;
      if (n > 1 && c.subzoneIndex != null) {
        map[c.id] = getSubzoneRect(zonePoints, c.subzoneIndex, n);
      } else {
        map[c.id] = zonePoints;
      }
    });
    return map;
  }, [circuits, zones]);

  /** Place room/zone corner on mousedown so the committed position is where the user pressed, not released (avoids small drift from mouse movement). */
  const handlePlaceRoomOrZone = (pointMeters: Point) => {
    const now = Date.now();
    if (now - lastCanvasClickTimeRef.current < 300) return;
    lastCanvasClickTimeRef.current = now;

    if (drawMode === "create-zone") {
      setDraftZone((current) => {
        if (!current) {
          const id = `zone-${Date.now()}`;
          const roomId = findContainingRoomId(pointMeters);
          const degenerate: Point[] = [pointMeters, pointMeters, pointMeters, pointMeters, pointMeters];
          const newZone: Zone = {
            id,
            name: `Zone ${zones.length + 1}`,
            points: degenerate,
            roomId,
            pipeSpacingM: pipeSpacingM
          };
          setZones((prev) => [...prev, newZone]);
          return { id, name: newZone.name, points: [pointMeters], roomId, pipeSpacingM: newZone.pipeSpacingM };
        }
        const first = current.points[0];
        if (!first) return current;
        const lastCorner = current.points[1] ?? pointMeters;
        const x1 = Math.min(first.x, lastCorner.x);
        const x2 = Math.max(first.x, lastCorner.x);
        const y1 = Math.min(first.y, lastCorner.y);
        const y2 = Math.max(first.y, lastCorner.y);
        const rectPoints: Point[] = [
          { x: x1, y: y1 },
          { x: x2, y: y1 },
          { x: x2, y: y2 },
          { x: x1, y: y2 },
          { x: x1, y: y1 }
        ];
        setZones((prev) =>
          prev.map((z) =>
            z.id === current.id
              ? {
                  ...z,
                  points: rectPoints,
                  roomId: z.roomId ?? findContainingRoomId({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 })
                }
              : z
          )
        );
        return null;
      });
      return;
    }

    if (drawMode === "create-room") {
      setDraftRoom((current) => {
        if (!current) {
          const id = `room-${Date.now()}`;
          const degenerate: Point[] = [pointMeters, pointMeters, pointMeters, pointMeters, pointMeters];
          const newRoom: Room = {
            id,
            name: `Room ${rooms.length + 1}`,
            points: degenerate
          };
          setRooms((prev) => [...prev, newRoom]);
          return { id, name: newRoom.name, points: [pointMeters] };
        }
        const first = current.points[0];
        if (!first) return current;
        const lastCorner = current.points[1] ?? pointMeters;
        const x1 = Math.min(first.x, lastCorner.x);
        const x2 = Math.max(first.x, lastCorner.x);
        const y1 = Math.min(first.y, lastCorner.y);
        const y2 = Math.max(first.y, lastCorner.y);
        const rectPoints: Point[] = [
          { x: x1, y: y1 },
          { x: x2, y: y1 },
          { x: x2, y: y2 },
          { x: x1, y: y2 },
          { x: x1, y: y1 }
        ];
        setRooms((prev) =>
          prev.map((r) => (r.id === current.id ? { ...r, points: rectPoints } : r))
        );
        return null;
      });
    }
  };

  const handleCanvasMouseDown = (pointMeters: Point) => {
    if (drawMode === "create-room" || drawMode === "create-zone") {
      handlePlaceRoomOrZone(pointMeters);
    }
  };

  const handleCanvasClick = (pointMeters: Point) => {
    const now = Date.now();
    if (now - lastCanvasClickTimeRef.current < 300) return;
    lastCanvasClickTimeRef.current = now;

    if (drawMode === "create-room" || drawMode === "create-zone") {
      return;
    }

    if (drawMode === "add-connection") {
      return;
    }

    if (drawMode === "edit-rooms" || drawMode === "edit-zones") {
      return;
    }
    if (drawMode === "manifold") {
      addManifold(pointMeters);
      return;
    }
    if (drawMode === "move-manifold") {
      return;
    }
  };

  const handleCanvasMove = (pointMeters: Point) => {
    if (cornerDragState) {
      const dx = pointMeters.x - cornerDragState.startMouse.x;
      const dy = pointMeters.y - cornerDragState.startMouse.y;
      const movedCorner = cornerDragState.originalPoints[cornerDragState.cornerIndex];
      const newPoint: Point = {
        x: movedCorner.x + dx,
        y: movedCorner.y + dy
      };
      const newPoints = updateRectCorner(
        cornerDragState.originalPoints,
        cornerDragState.cornerIndex,
        newPoint
      );
      if (cornerDragState.type === "room") {
        setRooms((prev) =>
          prev.map((room) =>
            room.id === cornerDragState.id ? { ...room, points: newPoints } : room
          )
        );
      } else {
        setZones((prev) =>
          prev.map((zone) =>
            zone.id === cornerDragState.id ? { ...zone, points: newPoints } : zone
          )
        );
      }
      return;
    }
    if (dragState) {
      const dx = pointMeters.x - dragState.startMouse.x;
      const dy = pointMeters.y - dragState.startMouse.y;
      const newPoints = dragState.originalPoints.map((p) => ({
        x: p.x + dx,
        y: p.y + dy
      }));
      if (dragState.type === "room") {
        setRooms((prev) =>
          prev.map((room) =>
            room.id === dragState.id ? { ...room, points: newPoints } : room
          )
        );
      } else {
        setZones((prev) =>
          prev.map((zone) =>
            zone.id === dragState.id ? { ...zone, points: newPoints } : zone
          )
        );
      }
      return;
    }
    if (draggingManifoldId) {
      const m = manifolds.find((x) => x.id === draggingManifoldId);
      if (m) updateManifold(draggingManifoldId, { position: pointMeters });
      return;
    }
    setDraftRoom((current) => {
      if (!current || current.points.length === 0) return current;
      if (drawMode !== "create-room") return current;
      const origin = current.points[0];
      return {
        ...current,
        points: [origin, pointMeters]
      };
    });
    setDraftZone((current) => {
      if (!current || current.points.length === 0) return current;
      if (drawMode !== "create-zone") return current;
      const origin = current.points[0];
      return {
        ...current,
        points: [origin, pointMeters]
      };
    });
  };

  const handleFinishRoom = () => {
    setDraftRoom((current) => {
      if (current) {
        setRooms((prev) =>
          prev.filter((r) => r.id !== current.id || !isDegenerateRect(r.points))
        );
      }
      return null;
    });
    setDraftZone((current) => {
      if (current) {
        setZones((prev) =>
          prev.filter((z) => z.id !== current.id || !isDegenerateRect(z.points))
        );
      }
      return null;
    });
  };

  const handleClearRooms = () => {
    setRooms([]);
    setDraftRoom(null);
    setDragState(null);
    setCornerDragState(null);
    setZones([]);
    setDraftZone(null);
  };

  const handleClearZones = () => {
    setZones([]);
    setDraftZone(null);
    setDragState((current) =>
      current && current.type === "zone" ? null : current
    );
    setCornerDragState((current) =>
      current && current.type === "zone" ? null : current
    );
  };

  const handlePixelsPerMeterChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    setPixelsPerMeter(value);
  };

  const handlePipeSpacingChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    setPipeSpacingM(value);
  };

  const handleMaxCircuitLengthChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    updateCurrentFloor({ maxCircuitLengthM: value });
  };

  const handlePipeRollLengthChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    updateCurrentFloor({ pipeRollLengthM: value });
  };

  const handleSaveLayout = () => {
    const layout: Layout = {
      pixelsPerMeter,
      currentFloorId,
      floors
    };
    const blob = new Blob([JSON.stringify(layout, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "layout.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCalculateCircuits = async () => {
    if (manifolds.length === 0) {
      return;
    }
    if (rooms.length === 0) {
      return;
    }

    const storeyId = "storey-1";

    const toPolygon = (points: Point[]) => {
      const closed =
        points.length > 0 && points[0].x === points[points.length - 1].x &&
        points[0].y === points[points.length - 1].y
          ? points
          : [...points, points[0]];
      return {
        boundary: {
          points: closed
        }
      };
    };

    const floorplan = {
      id: "floorplan-1",
      name: "Floor 1",
      pixels_per_meter: pixelsPerMeter,
      storeys: [
        {
          id: storeyId,
          name: "Storey 1",
          level_elevation: 0,
          type: "ground",
          rooms: rooms.map((room) => ({
            id: room.id,
            name: room.name,
            storey_id: storeyId,
            outline: toPolygon(room.points),
            obstacles: []
          })),
          manifolds: manifolds.map((m) => ({
            id: m.id,
            storey_id: storeyId,
            position: m.position,
            name: m.name ?? "Manifold"
          }))
        }
      ]
    };

    const zonesForBackend =
      zones.length > 0
        ? zones.map((zone) => ({
            id: zone.id,
            name: zone.name,
            storey_id: storeyId,
            room_ids: zone.roomId ? [zone.roomId] : [],
            geometry: toPolygon(zone.points)
          }))
        : rooms.map((room) => ({
            id: room.id,
            name: room.name,
            storey_id: storeyId,
            room_ids: [room.id],
            geometry: toPolygon(room.points)
          }));

    const project = {
      floorplan,
      zones: zonesForBackend,
      manifolds: manifolds.map((m) => ({
        id: m.id,
        storey_id: storeyId,
        position: m.position,
        name: m.name ?? "Manifold"
      }))
    };

    const pipe_spacing_by_zone_id: Record<string, number> | undefined =
      zones.length > 0
        ? Object.fromEntries(
            zones.map((z) => [z.id, z.pipeSpacingM ?? pipeSpacingM])
          )
        : undefined;

    const params = {
      pipe_spacing_m: pipeSpacingM,
      pipe_spacing_by_zone_id,
      max_circuit_length_m: currentFloor.maxCircuitLengthM ?? 60
    };

    try {
      const response = await fetch("http://localhost:8000/projects/calculate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ project, params })
      });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const backendCircuits: any[] = data.circuits ?? [];
      setCircuits(
        backendCircuits.map((c) => {
          const zone = zones.find((z) => z.id === c.zone_id);
          const room =
            zone?.roomId != null
              ? rooms.find((r) => r.id === zone.roomId)
              : rooms.find((r) => r.id === c.zone_id);
          const algorithm = typeof c.id === "string" && c.id.includes("_spiral_") ? "spiral" : "meander";
          return {
            id: c.id,
            name: c.name,
            lengthM: c.total_length_m ?? 0,
            roomId: room?.id ?? zone?.roomId ?? c.zone_id,
            roomName: room?.name ?? zone?.name ?? c.zone_id,
            zoneId: c.zone_id,
            zoneName: zone?.name ?? c.zone_id,
            subzoneIndex: c.subzone_index ?? null,
            algorithm
          };
        })
      );
      setPaths(
        backendCircuits.map((c) => ({
          id: c.id,
          points: (c.route?.points ?? []) as Point[]
        }))
      );
    } catch {
      // swallow network errors for now
    }
  };

  const handleLoadLayout = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const currentId = currentFloorId;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Layout & {
          rooms?: Room[];
          zones?: Zone[];
          manifoldPosition?: Point | null;
          manifoldConnections?: ManifoldConnection[];
          circuitInletOverrides?: Record<string, Point>;
        };
        if (!parsed) return;
        setPixelsPerMeter(parsed.pixelsPerMeter || defaultPixelsPerMeter);
        setDraftRoom(null);
        setDraftZone(null);
        if (Array.isArray(parsed.floors) && parsed.floors.length > 0) {
          setFloors(
            parsed.floors.map((f: any) => ({
              id: f.id ?? `floor-${Date.now()}`,
              name: f.name ?? "Floor",
              rooms: Array.isArray(f.rooms) ? f.rooms : [],
              zones: deduplicateZones(Array.isArray(f.zones) ? f.zones : []),
              manifolds: Array.isArray(f.manifolds)
                ? f.manifolds.map((m: any) => ({ id: m.id ?? `manifold-${Date.now()}`, position: m.position ?? { x: 0, y: 0 }, name: m.name }))
                : f.manifoldPosition ? [{ id: "manifold-1", position: f.manifoldPosition, name: "Manifold" }] : [],
              manifoldConnections: Array.isArray(f.manifoldConnections)
                ? f.manifoldConnections.map((c: any) => ({ circuitId: c.circuitId, manifoldId: c.manifoldId, points: c.points ?? [] }))
                : [],
              circuitInletOverrides:
                f.circuitInletOverrides && typeof f.circuitInletOverrides === "object"
                  ? f.circuitInletOverrides
                  : {},
              circuits: Array.isArray(f.circuits) ? f.circuits : [],
              paths: Array.isArray(f.paths) ? f.paths : [],
              maxCircuitLengthM: typeof f.maxCircuitLengthM === "number" ? f.maxCircuitLengthM : 60,
              pipeRollLengthM: typeof f.pipeRollLengthM === "number" ? f.pipeRollLengthM : 200
            }))
          );
          setCurrentFloorId(
            parsed.currentFloorId && parsed.floors.some((f: any) => f.id === parsed.currentFloorId)
              ? parsed.currentFloorId
              : parsed.floors[0].id
          );
        } else if (Array.isArray(parsed.rooms)) {
          const legacyFloorPatch = {
            rooms: parsed.rooms,
            zones: deduplicateZones(Array.isArray(parsed.zones) ? parsed.zones : []),
            manifolds: parsed.manifoldPosition ? [{ id: "manifold-1", position: parsed.manifoldPosition, name: "Manifold" }] : [],
            manifoldConnections: Array.isArray(parsed.manifoldConnections)
              ? parsed.manifoldConnections.map((c: any) => ({ circuitId: c.circuitId, manifoldId: c.manifoldId, points: c.points ?? [] }))
              : [],
            circuitInletOverrides:
              parsed.circuitInletOverrides && typeof parsed.circuitInletOverrides === "object"
                ? parsed.circuitInletOverrides
                : {},
            circuits: [] as CircuitRow[],
            paths: [] as CircuitPath[],
            maxCircuitLengthM: 60,
            pipeRollLengthM: 200
          };
          setFloors((prev) => {
            const hasCurrent = prev.some((f) => f.id === currentId);
            if (!hasCurrent) {
              return [...prev, { id: currentId, name: "Floor", ...legacyFloorPatch }];
            }
            return prev.map((f) =>
              f.id === currentId ? { ...f, ...legacyFloorPatch } : f
            );
          });
        }
      } catch {
        // ignore parse errors
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const loadAsFloorInputRef = useRef<HTMLInputElement>(null);

  const handleLoadAsFloor = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Layout & {
          rooms?: Room[];
          zones?: Zone[];
          manifoldPosition?: Point | null;
          manifoldConnections?: ManifoldConnection[];
          circuitInletOverrides?: Record<string, Point>;
        };
        if (!parsed) return;
        setDraftRoom(null);
        setDraftZone(null);
        setConnectionDrawing(null);
        if (Array.isArray(parsed.floors) && parsed.floors.length > 0) {
          const baseId = `floor-${Date.now()}`;
          let firstNewId: string | null = null;
          setFloors((prev) => {
            const newFloors: Floor[] = parsed.floors.map((f: any, i: number) => ({
              id: `${baseId}-${i}`,
              name: f.name ?? `Floor ${prev.length + i + 1}`,
              rooms: Array.isArray(f.rooms) ? f.rooms : [],
              zones: deduplicateZones(Array.isArray(f.zones) ? f.zones : []),
              manifolds: Array.isArray(f.manifolds)
                ? f.manifolds.map((m: any) => ({ id: m.id ?? `manifold-${Date.now()}-${i}`, position: m.position ?? { x: 0, y: 0 }, name: m.name }))
                : f.manifoldPosition ? [{ id: "manifold-1", position: f.manifoldPosition, name: "Manifold" }] : [],
              manifoldConnections: Array.isArray(f.manifoldConnections)
                ? f.manifoldConnections.map((c: any) => ({ circuitId: c.circuitId, manifoldId: c.manifoldId, points: c.points ?? [] }))
                : [],
              circuitInletOverrides:
                f.circuitInletOverrides && typeof f.circuitInletOverrides === "object"
                  ? f.circuitInletOverrides
                  : {},
              circuits: Array.isArray(f.circuits) ? f.circuits : [],
              paths: Array.isArray(f.paths) ? f.paths : [],
              maxCircuitLengthM: typeof f.maxCircuitLengthM === "number" ? f.maxCircuitLengthM : 60,
              pipeRollLengthM: typeof f.pipeRollLengthM === "number" ? f.pipeRollLengthM : 200
            }));
            firstNewId = newFloors[0]!.id;
            return [...prev, ...newFloors];
          });
          if (firstNewId) setCurrentFloorId(firstNewId);
        } else if (Array.isArray(parsed.rooms)) {
          const id = `floor-${Date.now()}`;
          setFloors((prev) => [
            ...prev,
            {
              id,
              name: `Floor ${prev.length + 1}`,
              rooms: parsed.rooms ?? [],
              zones: deduplicateZones(Array.isArray(parsed.zones) ? parsed.zones : []),
              manifolds: parsed.manifoldPosition ? [{ id: "manifold-1", position: parsed.manifoldPosition, name: "Manifold" }] : [],
              manifoldConnections: Array.isArray(parsed.manifoldConnections)
                ? parsed.manifoldConnections.map((c: any) => ({ circuitId: c.circuitId, manifoldId: c.manifoldId, points: c.points ?? [] }))
                : [],
              circuitInletOverrides:
                parsed.circuitInletOverrides && typeof parsed.circuitInletOverrides === "object"
                  ? parsed.circuitInletOverrides
                  : {},
              circuits: [],
              paths: [],
              maxCircuitLengthM: 60,
              pipeRollLengthM: 200
            }
          ]);
          setCurrentFloorId(id);
        }
      } catch {
        // ignore parse errors
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const toShapeSummary = (id: string, name: string, points: Point[]): ShapeSummary => {
    if (points.length === 0) return { id, name, width: 0, height: 0 };
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    return { id, name, width, height };
  };

  const roomSummaries: ShapeSummary[] = rooms.map((r) =>
    toShapeSummary(r.id, r.name, r.points)
  );
  const zoneSummaries: ShapeSummary[] = zones.map((z) =>
    toShapeSummary(z.id, z.name, z.points)
  );

  const draftRoomSummary =
    draftRoom && draftRoom.points.length > 0
      ? (() => {
          const origin = draftRoom.points[0];
          const corner = draftRoom.points[1] ?? origin;
          return {
            width: Math.abs(corner.x - origin.x),
            height: Math.abs(corner.y - origin.y)
          };
        })()
      : null;
  const draftZoneSummary =
    draftZone && draftZone.points.length > 0
      ? (() => {
          const origin = draftZone.points[0];
          const corner = draftZone.points[1] ?? origin;
          return {
            width: Math.abs(corner.x - origin.x),
            height: Math.abs(corner.y - origin.y)
          };
        })()
      : null;

  const handleDraftDimensionChange = (field: "width" | "height", value: number) => {
    if (!draftRoom || draftRoom.points.length === 0) return;
    if (!Number.isFinite(value) || value < 0) return;
    const origin = draftRoom.points[0];
    const corner = draftRoom.points[1] ?? origin;
    const current = {
      width: Math.abs(corner.x - origin.x),
      height: Math.abs(corner.y - origin.y)
    };
    const next = {
      width: field === "width" ? value : current.width,
      height: field === "height" ? value : current.height
    };
    const signX = corner.x >= origin.x ? 1 : -1;
    const signY = corner.y >= origin.y ? 1 : -1;
    const newCorner: Point = {
      x: origin.x + signX * next.width,
      y: origin.y + signY * next.height
    };
    setDraftRoom({ ...draftRoom, points: [origin, newCorner] });
  };

  const handleDraftZoneDimensionChange = (field: "width" | "height", value: number) => {
    if (!draftZone || draftZone.points.length === 0) return;
    if (!Number.isFinite(value) || value < 0) return;
    const origin = draftZone.points[0];
    const corner = draftZone.points[1] ?? origin;
    const current = {
      width: Math.abs(corner.x - origin.x),
      height: Math.abs(corner.y - origin.y)
    };
    const next = {
      width: field === "width" ? value : current.width,
      height: field === "height" ? value : current.height
    };
    const signX = corner.x >= origin.x ? 1 : -1;
    const signY = corner.y >= origin.y ? 1 : -1;
    const newCorner: Point = {
      x: origin.x + signX * next.width,
      y: origin.y + signY * next.height
    };
    setDraftZone({ ...draftZone, points: [origin, newCorner] });
  };

  const updateRectDimensions = (
    points: Point[],
    field: "width" | "height",
    value: number
  ): Point[] => {
    if (points.length === 0) return points;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const currentWidth = maxX - minX;
    const currentHeight = maxY - minY;
    const nextWidth = field === "width" ? value : currentWidth;
    const nextHeight = field === "height" ? value : currentHeight;
    const x1 = minX;
    const x2 = minX + nextWidth;
    const y1 = minY;
    const y2 = minY + nextHeight;
    return [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
      { x: x1, y: y1 }
    ];
  };

  const handleRoomDimensionChange = (
    roomId: string,
    field: "width" | "height",
    value: number
  ) => {
    if (!Number.isFinite(value) || value < 0) return;
    setRooms((prev) =>
      prev.map((room) => {
        if (room.id !== roomId || room.points.length === 0) return room;
        return { ...room, points: updateRectDimensions(room.points, field, value) };
      })
    );
  };

  const handleZoneDimensionChange = (
    zoneId: string,
    field: "width" | "height",
    value: number
  ) => {
    if (!Number.isFinite(value) || value < 0) return;
    setZones((prev) =>
      prev.map((zone) => {
        if (zone.id !== zoneId || zone.points.length === 0) return zone;
        return { ...zone, points: updateRectDimensions(zone.points, field, value) };
      })
    );
  };

  const handleZonePipeSpacingChange = (zoneId: string, value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    setZones((prev) =>
      prev.map((z) => (z.id === zoneId ? { ...z, pipeSpacingM: value } : z))
    );
  };

  const handleDeleteRoom = (roomId: string) => {
    setRooms((prev) => prev.filter((room) => room.id !== roomId));
  };

  const handleDeleteZone = (zoneId: string) => {
    setZones((prev) => prev.filter((zone) => zone.id !== zoneId));
  };

  const handleRoomRename = (roomId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setRooms((prev) =>
      prev.map((room) => (room.id === roomId ? { ...room, name: trimmed } : room))
    );
  };

  const handleZoneRename = (zoneId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setZones((prev) =>
      prev.map((zone) => (zone.id === zoneId ? { ...zone, name: trimmed } : zone))
    );
  };

  const handleCloneZone = (zoneId: string) => {
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;
    const clone: Zone = {
      id: `zone-${Date.now()}`,
      name: `${zone.name} (copy)`,
      points: zone.points.map((p) => ({ ...p })),
      roomId: zone.roomId,
      pipeSpacingM: zone.pipeSpacingM
    };
    setZones((prev) => [...prev, clone]);
  };

  /** True if zone rectangle (bbox) is fully inside room rectangle (bbox). */
  const isZoneInsideRoom = (zonePoints: Point[], roomPoints: Point[]): boolean => {
    if (zonePoints.length < 4 || roomPoints.length < 4) return false;
    const zx = zonePoints.map((p) => p.x);
    const zy = zonePoints.map((p) => p.y);
    const rx = roomPoints.map((p) => p.x);
    const ry = roomPoints.map((p) => p.y);
    const zMinX = Math.min(...zx);
    const zMaxX = Math.max(...zx);
    const zMinY = Math.min(...zy);
    const zMaxY = Math.max(...zy);
    const rMinX = Math.min(...rx);
    const rMaxX = Math.max(...rx);
    const rMinY = Math.min(...ry);
    const rMaxY = Math.max(...ry);
    return zMinX >= rMinX && zMaxX <= rMaxX && zMinY >= rMinY && zMaxY <= rMaxY;
  };

  const getRoomContainingZone = (zone: Zone): Room | undefined =>
    rooms.find((room) => isZoneInsideRoom(zone.points, room.points));

  const canExpandZone = (zoneId: string): boolean => {
    const zone = zones.find((z) => z.id === zoneId);
    return zone != null && getRoomContainingZone(zone) != null;
  };

  const handleExpandZone = (zoneId: string) => {
    const zone = zones.find((z) => z.id === zoneId);
    const room = zone ? getRoomContainingZone(zone) : null;
    if (!zone || !room) return;
    setZones((prev) =>
      prev.map((z) =>
        z.id !== zoneId ? z : { ...z, points: room.points.map((p) => ({ ...p })), roomId: room.id }
      )
    );
  };

  const handleAddFloor = () => {
    const nextIndex = floors.length + 1;
    const id = `floor-${Date.now()}`;
    const name = `Floor ${nextIndex}`;
    setFloors((prev) => [...prev, newFloor(id, name)]);
    setCurrentFloorId(id);
    setDraftRoom(null);
    setDraftZone(null);
    setConnectionDrawing(null);
  };

  const handleSwitchFloor = (floorId: string) => {
    if (floorId === currentFloorId) return;
    setCurrentFloorId(floorId);
    setDraftRoom(null);
    setDraftZone(null);
    setConnectionDrawing(null);
    setDragState(null);
    setCornerDragState(null);
  };

  const handleDeleteFloor = (floorId: string) => {
    if (floors.length <= 1) return;
    const index = floors.findIndex((f) => f.id === floorId);
    if (index === -1) return;
    setFloors((prev) => prev.filter((f) => f.id !== floorId));
    if (currentFloorId === floorId) {
      const remaining = floors.filter((f) => f.id !== floorId);
      const nextIndex = Math.min(index, remaining.length - 1);
      setCurrentFloorId(remaining[Math.max(0, nextIndex)]!.id);
    }
    setEditingFloor((prev) => (prev?.id === floorId ? null : prev));
    setDraftRoom(null);
    setDraftZone(null);
    setConnectionDrawing(null);
  };

  const pipeSpacingByZoneId: Record<string, number> = {};
  zones.forEach((z) => {
    if (z.pipeSpacingM != null) pipeSpacingByZoneId[z.id] = z.pipeSpacingM;
  });

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <h1 className="app-title">RadiantWeave – Underfloor Heating Designer</h1>
          <p className="app-subtitle">
            Draw rooms and zones, place the manifold, and let RadiantWeave propose tidy
            underfloor heating circuits.
          </p>
        </div>
        <div className="app-header-actions">
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.35rem" }}>
            <div className="app-badge">MPL-2.0 licensed</div>
            <div className="app-author">Daljeet Singh Nandha, © 2026</div>
          </div>
          <button
            type="button"
            onClick={() => setShowHelpModal(true)}
            className="help-button"
            aria-label="Help"
          >
            Help
          </button>
        </div>
      </header>
      {showHelpModal && <HelpModal onClose={() => setShowHelpModal(false)} />}
      {floorToDelete && (() => {
        const floor = floors.find((f) => f.id === floorToDelete);
        if (!floor) return null;
        return (
          <div
            className="help-modal-overlay"
            onClick={() => setFloorToDelete(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-floor-title"
          >
            <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
              <h2 id="confirm-delete-floor-title" className="confirm-modal-title">
                Delete floor?
              </h2>
              <p className="confirm-modal-body">
                Delete &quot;{floor.name}&quot;? This cannot be undone.
              </p>
              <div className="confirm-modal-actions">
                <button
                  type="button"
                  className="confirm-modal-btn confirm-modal-btn--cancel"
                  onClick={() => setFloorToDelete(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="confirm-modal-btn confirm-modal-btn--danger"
                  onClick={() => {
                    handleDeleteFloor(floorToDelete);
                    setFloorToDelete(null);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="app-toolbar">
        <div className="app-toolbar-row">
          <span className="app-toolbar-row__label">Layout</span>
          <div className="app-toolbar-group">
            <button type="button" onClick={handleSaveLayout}>
              Save layout
            </button>
            <label>
              <span>Load layout:</span>
              <input type="file" accept="application/json" onChange={handleLoadLayout} />
            </label>
            <button
              type="button"
              onClick={() => loadAsFloorInputRef.current?.click()}
              title="Load a layout file as a new floor"
            >
              Load as floor
            </button>
            <input
              ref={loadAsFloorInputRef}
              type="file"
              accept="application/json"
              onChange={handleLoadAsFloor}
              style={{ display: "none" }}
              aria-hidden
            />
          </div>
        </div>
        <div className="app-toolbar-row">
          <span className="app-toolbar-row__label">Floor</span>
          <div className="app-toolbar-group app-toolbar-floors">
            {floors.map((f) => (
              <span key={f.id} className="floor-tab-wrap">
                {editingFloor?.id === f.id ? (
                  <input
                    ref={editingFloorInputRef}
                    type="text"
                    className={`floor-tab floor-tab--input ${f.id === currentFloorId ? "floor-tab--active" : ""}`}
                    value={editingFloor.name}
                    onChange={(e) => setEditingFloor((prev) => (prev ? { ...prev, name: e.target.value } : null))}
                    onBlur={() => editingFloor && commitFloorRename(editingFloor.id, editingFloor.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        editingFloor && commitFloorRename(editingFloor.id, editingFloor.name);
                      } else if (e.key === "Escape") {
                        setEditingFloor(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSwitchFloor(f.id)}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      setEditingFloor({ id: f.id, name: f.name });
                    }}
                    className={f.id === currentFloorId ? "floor-tab floor-tab--active" : "floor-tab"}
                  >
                    {f.name}
                  </button>
                )}
                {floors.length > 1 && (
                  <button
                    type="button"
                    className="floor-tab-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFloorToDelete(f.id);
                    }}
                    title={`Delete ${f.name}`}
                    aria-label={`Delete ${f.name}`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            <button type="button" onClick={handleAddFloor} className="floor-add">
              + Add floor
            </button>
          </div>
        </div>
        <div className="app-toolbar-row">
          <span className="app-toolbar-row__label">Circuits</span>
          <div className="app-toolbar-group">
            <label>
              <span>Max length (m):</span>
              <input
                type="number"
                min={1}
                step={0.01}
                value={currentFloor.maxCircuitLengthM ?? 60}
                onChange={handleMaxCircuitLengthChange}
              />
            </label>
            <label>
              <span>Pipe roll length (m):</span>
              <input
                type="number"
                min={1}
                step={0.01}
                value={currentFloor.pipeRollLengthM ?? 200}
                onChange={handlePipeRollLengthChange}
              />
            </label>
            <button type="button" onClick={handlePrint}>
              Print
            </button>
          </div>
        </div>
      </div>

      <div className="app-draw-toolbar">
        <div className="app-toolbar-row">
          <div className="app-toolbar-group">
            <DrawModeButtons value={drawMode} onChange={setDrawMode} />
          </div>
          <div className="app-toolbar-group">
            <button type="button" className="draw-action-btn" onClick={handleFinishRoom}>
              Cancel draft
            </button>
            <button type="button" className="draw-action-btn" onClick={handleClearRooms}>
              Clear rooms
            </button>
            <button type="button" className="draw-action-btn" onClick={handleClearZones}>
              Clear zones
            </button>
          </div>
        </div>
      </div>

      <main className="app-main">
        <div className="app-canvas-column">
          <div className="panel app-scale-card">
            <div className="app-toolbar-row">
              <span className="app-toolbar-row__label">Scale</span>
              <div className="app-toolbar-group">
                <label>
                  <span>Pixels per meter:</span>
                  <input
                    type="number"
                    value={pixelsPerMeter}
                    min={1}
                step={0.01}
                    onChange={handlePixelsPerMeterChange}
                  />
                </label>
                <button
                  type="button"
                  className="draw-action-btn"
                  onClick={handleCenterPlan}
                  title="Move the plan to center"
                >
                  Center
                </button>
              </div>
            </div>
          </div>
          <section className="app-canvas-wrapper">
            <FloorplanCanvas
          ref={canvasRef}
          circuits={paths}
          rooms={rooms}
          zones={zones}
          tempRoom={draftRoom}
          tempZone={draftZone}
          pixelsPerMeter={pixelsPerMeter}
          drawMode={drawMode}
          onCanvasClick={handleCanvasClick}
          onCanvasMouseDown={handleCanvasMouseDown}
          onCanvasMove={handleCanvasMove}
          manifolds={manifolds}
          onManifoldMouseDown={
            drawMode === "move-manifold" ? (id) => setDraggingManifoldId(id) : undefined
          }
          onRoomMouseDown={(roomId, point) => {
            if (drawMode !== "edit-rooms") return;
            const room = rooms.find((r) => r.id === roomId);
            if (!room) return;
            setDragState({
              type: "room",
              id: roomId,
              startMouse: point,
              originalPoints: room.points
            });
          }}
          onZoneMouseDown={(zoneId, point) => {
            if (drawMode !== "edit-zones") return;
            const zone = zones.find((z) => z.id === zoneId);
            if (!zone) return;
            setDragState({
              type: "zone",
              id: zoneId,
              startMouse: point,
              originalPoints: zone.points
            });
          }}
          onRoomCornerMouseDown={(roomId, cornerIndex, point) => {
            const room = rooms.find((r) => r.id === roomId);
            if (!room) return;
            setCornerDragState({
              type: "room",
              id: roomId,
              cornerIndex,
              startMouse: point,
              originalPoints: room.points
            });
          }}
          onZoneCornerMouseDown={(zoneId, cornerIndex, point) => {
            const zone = zones.find((z) => z.id === zoneId);
            if (!zone) return;
            setCornerDragState({
              type: "zone",
              id: zoneId,
              cornerIndex,
              startMouse: point,
              originalPoints: zone.points
            });
          }}
          manifoldConnections={manifoldConnections}
          connectionDrawing={connectionDrawing?.points ?? null}
          connectionStartCircuitId={connectionDrawing?.startCircuitId}
          onConnectionStartAtManifold={
            drawMode === "add-connection" ? (manifoldId: string, point: Point) => handleConnectionStartAtManifold(manifoldId, point) : undefined
          }
          onConnectionStartAtInlet={
            drawMode === "add-connection" ? handleConnectionStartAtInlet : undefined
          }
          onFinishConnectionAtManifold={
            drawMode === "add-connection" ? (manifoldId: string) => handleFinishConnectionAtManifold(manifoldId) : undefined
          }
          onConnectionFinishAtInlet={
            drawMode === "add-connection" ? handleConnectionFinishAtInlet : undefined
          }
          onConnectionAddPoint={
            drawMode === "add-connection" ? handleConnectionAddPoint : undefined
          }
          circuitInletOverrides={circuitInletOverrides}
          circuitIdToZoneId={circuitIdToZoneId}
          circuitIdToInletConstraintRect={circuitIdToInletConstraintRect}
          onInletOverrideChange={
            drawMode === "move-inlet" ? handleInletOverrideChange : undefined
          }
          connectionGridM={CONNECTION_GRID_M}
        />
          </section>
        </div>

        <aside className="app-sidebar">
          <button
            type="button"
            onClick={handleCalculateCircuits}
            className="calculate-btn"
          >
            Calculate circuits
          </button>
          <div className="panel">
            <div className="panel-title" style={{ marginBottom: 8 }}>
              <span>Circuits</span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  className={circuitViewScope === "current-floor" ? "panel-title-btn" : undefined}
                  style={
                    circuitViewScope === "current-floor"
                      ? { fontWeight: 600 }
                      : { background: "transparent", border: "1px solid #ccc" }
                  }
                  onClick={() => setCircuitViewScope("current-floor")}
                >
                  Current floor
                </button>
                <button
                  type="button"
                  className={circuitViewScope === "all-floors" ? "panel-title-btn" : undefined}
                  style={
                    circuitViewScope === "all-floors"
                      ? { fontWeight: 600 }
                      : { background: "transparent", border: "1px solid #ccc" }
                  }
                  onClick={() => setCircuitViewScope("all-floors")}
                >
                  All floors
                </button>
              </div>
            </div>
            <CircuitsTotalsCard
              circuits={displayCircuits}
              manifoldConnections={displayManifoldConnections}
              manifolds={displayManifolds}
              pipeRollLengthM={displayPipeRollLengthM}
            />
          </div>
          <div className="panel">
            <ShapeListPanel
            title="Rooms (dimensions in meters)"
            items={roomSummaries}
            emptyMessage="Click two opposite corners on the canvas to draw a rectangular room."
            onDimensionChange={handleRoomDimensionChange}
            onRename={handleRoomRename}
            onDelete={handleDeleteRoom}
            draft={draftRoomSummary}
            onDraftDimensionChange={handleDraftDimensionChange}
            draftTitle="Draft room dimensions"
            cancelHint='Press Esc or "Cancel draft" to cancel.'
            />
          </div>

          <div className="panel panel--accent">
            <ZonesPanel
            zoneSummaries={zoneSummaries}
            pipeSpacingByZoneId={pipeSpacingByZoneId}
            defaultPipeSpacingM={pipeSpacingM}
            onDimensionChange={handleZoneDimensionChange}
            onPipeSpacingChange={handleZonePipeSpacingChange}
            onRename={handleZoneRename}
            onClone={handleCloneZone}
            onDelete={handleDeleteZone}
            onExpand={handleExpandZone}
            canExpand={canExpandZone}
            draft={draftZoneSummary}
            onDraftDimensionChange={handleDraftZoneDimensionChange}
            emptyMessage="Draw rooms first, then click two opposite corners inside a room to draw a zone."
            cancelHint='Press Esc or "Cancel draft" to cancel.'
            />
          </div>

          <div className="panel">
            <CircuitSummary
              circuits={displayCircuits}
              manifoldConnections={displayManifoldConnections}
              pipeRollLengthM={displayPipeRollLengthM}
            />
          </div>

          <div className="panel">
            <div className="panel-title">
              <span>Manifold connections</span>
              <span className="panel-subtitle">
                Pipes from manifold to circuit inlets
              </span>
            </div>
            {drawMode === "add-connection" && (
              <p style={{ color: "#64748b", marginTop: 4 }}>
                Start at the manifold (red) or a circuit inlet (white circle).
                Add path points, then finish at an inlet or the manifold. Esc to
                cancel.
              </p>
            )}
            {manifoldConnections.length === 0 ? (
              <div className="panel-empty">
                No connections. Use &quot;Add connection&quot; mode; start at
                manifold or inlet.
              </div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
                {manifoldConnections.map((conn) => {
                  const circuitName =
                    circuits.find((c) => c.id === conn.circuitId)?.name ??
                    conn.circuitId;
                  return (
                    <li
                      key={conn.circuitId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "4px 0",
                        borderBottom: "1px solid #eee"
                      }}
                    >
                      <span>{circuitName}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setManifoldConnections((prev) =>
                            prev.filter((c) => c.circuitId !== conn.circuitId)
                          )
                        }
                        style={{ padding: "2px 6px" }}
                      >
                        Delete
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="panel manifold-card">
            <div className="panel-title">
              <span>Manifolds</span>
              <span className="panel-subtitle">Position (m). Place manifold mode: click canvas to add.</span>
            </div>
            {manifolds.length === 0 ? (
              <div className="panel-empty">
                Switch to “Place manifold” and click on the canvas to add one.
              </div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
                {manifolds.map((m) => (
                  <li
                    key={m.id}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "0.5rem",
                      marginBottom: 8,
                      paddingBottom: 8,
                      borderBottom: "1px solid #eee"
                    }}
                  >
                    <span style={{ minWidth: 80 }}>{m.name ?? "Manifold"}</span>
                    <label>
                      <span style={{ marginRight: 4 }}>X</span>
                      <input
                        type="number"
                        style={{ width: 64 }}
                        step={0.01}
                        value={m.position.x}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) updateManifold(m.id, { position: { ...m.position, x: n } });
                        }}
                      />
                    </label>
                    <label>
                      <span style={{ marginRight: 4 }}>Y</span>
                      <input
                        type="number"
                        style={{ width: 64 }}
                        step={0.01}
                        value={m.position.y}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) updateManifold(m.id, { position: { ...m.position, y: n } });
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => removeManifold(m.id)}
                      style={{ padding: "2px 6px", marginLeft: "auto" }}
                      title="Remove manifold"
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </main>
      {printMode && (
        <div className="print-section">
          {floors.map((floor) => (
            <section key={floor.id} className="print-floor-section">
              <h2>{floor.name}</h2>
              <div className="print-floor-canvas-wrapper">
                <FloorplanCanvas
                  circuits={floor.paths}
                  rooms={floor.rooms}
                  zones={floor.zones}
                  tempRoom={null}
                  tempZone={null}
                  pixelsPerMeter={pixelsPerMeter}
                  alignTopLeft
                  manifolds={floor.manifolds ?? []}
                  manifoldConnections={floor.manifoldConnections}
                  circuitInletOverrides={floor.circuitInletOverrides}
                />
              </div>
            </section>
          ))}
          {printData && (
            <section className="print-summary-section">
              <h2>Circuits summary (all floors)</h2>
              <div className="print-summary-card">
                <CircuitsTotalsCard
                  circuits={printData.combinedCircuits}
                  manifoldConnections={printData.combinedManifoldConnections}
                  manifolds={printData.combinedManifolds}
                  pipeRollLengthM={printData.rollM}
                />
              </div>
              <div className="print-summary-card">
                <CircuitSummary
                  circuits={printData.combinedCircuits}
                  manifoldConnections={printData.combinedManifoldConnections}
                  pipeRollLengthM={printData.rollM}
                />
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
};


