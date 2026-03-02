import React, { ChangeEvent, useEffect, useRef, useState } from "react";
import { FloorplanCanvas } from "./components/FloorplanCanvas";
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
  points: Point[];
};

type Floor = {
  id: string;
  name: string;
  rooms: Room[];
  zones: Zone[];
  manifoldPosition?: Point | null;
  manifoldConnections: ManifoldConnection[];
  circuitInletOverrides: Record<string, Point>;
  circuits: CircuitRow[];
  paths: CircuitPath[];
};

type Layout = {
  pixelsPerMeter: number;
  currentFloorId?: string;
  floors: Floor[];
};

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
    manifoldPosition: null,
    manifoldConnections: [],
    circuitInletOverrides: {},
    circuits: [],
    paths: []
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
  const [drawMode, setDrawMode] = useState<DrawMode>("create-room");
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
  const [maxCircuitLengthM, setMaxCircuitLengthM] = useState<number>(60);
  const [manifoldEditingKey, setManifoldEditingKey] = useState<"x" | "y" | null>(
    null
  );
  const [manifoldEditingValue, setManifoldEditingValue] = useState("");
  const [connectionDrawing, setConnectionDrawing] = useState<{
    points: Point[];
    startCircuitId?: string;
  } | null>(null);
  const lastCanvasClickTimeRef = useRef(0);
  const [showHelpModal, setShowHelpModal] = useState(false);

  const currentFloor = React.useMemo(
    () => floors.find((f) => f.id === currentFloorId) ?? floors[0]!,
    [floors, currentFloorId]
  );
  const rooms = currentFloor.rooms;
  const zones = currentFloor.zones;
  const manifoldPosition = currentFloor.manifoldPosition ?? null;
  const manifoldConnections = currentFloor.manifoldConnections;
  const circuitInletOverrides = currentFloor.circuitInletOverrides;
  const circuits = currentFloor.circuits;
  const paths = currentFloor.paths;

  const updateCurrentFloor = React.useCallback(
    (patch: Partial<Floor>) => {
      setFloors((prev) =>
        prev.map((f) => (f.id !== currentFloorId ? f : { ...f, ...patch }))
      );
    },
    [currentFloorId]
  );
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
  const setManifoldPosition = (value: Point | null) => {
    updateCurrentFloor({ manifoldPosition: value });
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
              zones: Array.isArray(f.zones) ? f.zones : [],
              manifoldPosition: f.manifoldPosition ?? null,
              manifoldConnections: Array.isArray(f.manifoldConnections)
                ? f.manifoldConnections.map((c: any) => ({
                    circuitId: c.circuitId,
                    points: c.points ?? []
                  }))
                : [],
              circuitInletOverrides:
                f.circuitInletOverrides && typeof f.circuitInletOverrides === "object"
                  ? f.circuitInletOverrides
                  : {},
              circuits: Array.isArray(f.circuits) ? f.circuits : [],
              paths: Array.isArray(f.paths) ? f.paths : []
            }))
          );
          if (parsed.currentFloorId && parsed.floors.some((f: any) => f.id === parsed.currentFloorId)) {
            setCurrentFloorId(parsed.currentFloorId);
          } else {
            setCurrentFloorId(parsed.floors[0].id);
          }
        } else if (Array.isArray(parsed.rooms)) {
          // Migrate old layout: single floor from top-level rooms/zones
          setFloors([
            {
              id: "floor-1",
              name: "Ground floor",
              rooms: parsed.rooms,
              zones: Array.isArray(parsed.zones) ? parsed.zones : [],
              manifoldPosition: parsed.manifoldPosition ?? null,
              manifoldConnections: Array.isArray(parsed.manifoldConnections)
                ? parsed.manifoldConnections.map((c: any) => ({
                    circuitId: c.circuitId,
                    points: c.points ?? []
                  }))
                : [],
              circuitInletOverrides:
                parsed.circuitInletOverrides && typeof parsed.circuitInletOverrides === "object"
                  ? parsed.circuitInletOverrides
                  : {},
              circuits: [],
              paths: []
            }
          ]);
          setCurrentFloorId("floor-1");
        }
      }
    } catch {
      // ignore malformed storage
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraftRoom(null);
        setDraftZone(null);
        setConnectionDrawing(null);
        setDragState(null);
        setCornerDragState(null);
      }
    };
    const handleMouseUp = () => {
      setDragState(null);
      setCornerDragState(null);
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

  const handleConnectionStartAtManifold = () => {
    if (!manifoldPosition) return;
    setConnectionDrawing({ points: [manifoldPosition] });
  };

  const handleConnectionStartAtInlet = (circuitId: string, point: Point) => {
    setConnectionDrawing({ points: [point], startCircuitId: circuitId });
  };

  const handleFinishConnectionAtManifold = () => {
    if (!connectionDrawing || connectionDrawing.points.length < 1 || !connectionDrawing.startCircuitId || !manifoldPosition) return;
    const last = connectionDrawing.points[connectionDrawing.points.length - 1]!;
    const points: Point[] = [...connectionDrawing.points];
    if (last.x !== manifoldPosition.x || last.y !== manifoldPosition.y) {
      points.push(snapToOrthogonal(last, manifoldPosition));
    }
    points.push(manifoldPosition);
    setManifoldConnections((prev) =>
      prev.filter((c) => c.circuitId !== connectionDrawing.startCircuitId).concat({
        circuitId: connectionDrawing.startCircuitId,
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
    const toAdd = snapToOrthogonal(last, pointMeters);
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
          const nextIndex = zones.length + 1;
          return {
            id: `zone-${nextIndex}`,
            name: `Zone ${nextIndex}`,
            points: [pointMeters],
            roomId: findContainingRoomId(pointMeters)
          };
        }
        const first = current.points[0];
        if (!first) {
          const nextIndex = zones.length + 1;
          return {
            id: `zone-${nextIndex}`,
            name: `Zone ${nextIndex}`,
            points: [pointMeters],
            roomId: findContainingRoomId(pointMeters)
          };
        }
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
        const completed: Zone = {
          ...current,
          points: rectPoints,
          roomId:
            current.roomId ??
            findContainingRoomId({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 }),
          pipeSpacingM: current.pipeSpacingM ?? pipeSpacingM
        };
        setZones((prev) => [...prev, completed]);
        return null;
      });
      return;
    }

    if (drawMode === "create-room") {
      setDraftRoom((current) => {
        if (!current) {
          return {
            id: `room-${rooms.length + 1}`,
            name: `Room ${rooms.length + 1}`,
            points: [pointMeters]
          };
        }
        const first = current.points[0];
        if (!first) {
          return {
            id: `room-${rooms.length + 1}`,
            name: `Room ${rooms.length + 1}`,
            points: [pointMeters]
          };
        }
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
        const completed: Room = {
          ...current,
          points: rectPoints
        };
        setRooms((prev) => [...prev, completed]);
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
      setManifoldPosition(pointMeters);
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
    // Explicit finish now acts as cancel for the current draft.
    setDraftRoom(null);
    setDraftZone(null);
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
    setMaxCircuitLengthM(value);
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
    if (!manifoldPosition) {
      // Manifold is required as reference.
      return;
    }
    if (rooms.length === 0) {
      return;
    }

    const storeyId = "storey-1";
    const manifoldId = "manifold-1";

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
          manifolds: [
            {
              id: manifoldId,
              storey_id: storeyId,
              position: manifoldPosition,
              name: "Manifold"
            }
          ]
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
      manifolds: [
        {
          id: manifoldId,
          storey_id: storeyId,
          position: manifoldPosition,
          name: "Manifold"
        }
      ]
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
      max_circuit_length_m: maxCircuitLengthM
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
          return {
            id: c.id,
            name: c.name,
            lengthM: c.total_length_m ?? 0,
            roomId: room?.id ?? zone?.roomId ?? c.zone_id,
            roomName: room?.name ?? zone?.name ?? c.zone_id,
            zoneId: c.zone_id,
            zoneName: zone?.name ?? c.zone_id,
            subzoneIndex: c.subzone_index ?? null
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
              zones: Array.isArray(f.zones) ? f.zones : [],
              manifoldPosition: f.manifoldPosition ?? null,
              manifoldConnections: Array.isArray(f.manifoldConnections)
                ? f.manifoldConnections.map((c: any) => ({ circuitId: c.circuitId, points: c.points ?? [] }))
                : [],
              circuitInletOverrides:
                f.circuitInletOverrides && typeof f.circuitInletOverrides === "object"
                  ? f.circuitInletOverrides
                  : {},
              circuits: Array.isArray(f.circuits) ? f.circuits : [],
              paths: Array.isArray(f.paths) ? f.paths : []
            }))
          );
          setCurrentFloorId(
            parsed.currentFloorId && parsed.floors.some((f: any) => f.id === parsed.currentFloorId)
              ? parsed.currentFloorId
              : parsed.floors[0].id
          );
        } else if (Array.isArray(parsed.rooms)) {
          setFloors([
            {
              id: "floor-1",
              name: "Ground floor",
              rooms: parsed.rooms,
              zones: Array.isArray(parsed.zones) ? parsed.zones : [],
              manifoldPosition: parsed.manifoldPosition ?? null,
              manifoldConnections: Array.isArray(parsed.manifoldConnections)
                ? parsed.manifoldConnections.map((c: any) => ({ circuitId: c.circuitId, points: c.points ?? [] }))
                : [],
              circuitInletOverrides:
                parsed.circuitInletOverrides && typeof parsed.circuitInletOverrides === "object"
                  ? parsed.circuitInletOverrides
                  : {},
              circuits: [],
              paths: []
            }
          ]);
          setCurrentFloorId("floor-1");
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
          </div>
        </div>
        <div className="app-toolbar-row">
          <span className="app-toolbar-row__label">Floor</span>
          <div className="app-toolbar-group app-toolbar-floors">
            {floors.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => handleSwitchFloor(f.id)}
                className={f.id === currentFloorId ? "floor-tab floor-tab--active" : "floor-tab"}
              >
                {f.name}
              </button>
            ))}
            <button type="button" onClick={handleAddFloor} className="floor-add">
              + Add floor
            </button>
          </div>
        </div>
        <div className="app-toolbar-row">
          <span className="app-toolbar-row__label">Scale</span>
          <div className="app-toolbar-group">
            <label>
              <span>Pixels per meter:</span>
              <input
                type="number"
                value={pixelsPerMeter}
                min={1}
                onChange={handlePixelsPerMeterChange}
              />
            </label>
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
                step={1}
                value={maxCircuitLengthM}
                onChange={handleMaxCircuitLengthChange}
              />
            </label>
          </div>
        </div>
      </div>

      <div className="app-draw-toolbar">
        <div className="app-toolbar-row">
          <span className="app-toolbar-row__label">Draw</span>
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
        <section className="app-canvas-wrapper">
          <FloorplanCanvas
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
          manifoldPosition={manifoldPosition}
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
            drawMode === "add-connection" ? handleConnectionStartAtManifold : undefined
          }
          onConnectionStartAtInlet={
            drawMode === "add-connection" ? handleConnectionStartAtInlet : undefined
          }
          onFinishConnectionAtManifold={
            drawMode === "add-connection" ? handleFinishConnectionAtManifold : undefined
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
        />
        </section>

        <aside className="app-sidebar">
          <button
            type="button"
            onClick={handleCalculateCircuits}
            className="calculate-btn"
          >
            Calculate circuits
          </button>
          <CircuitsTotalsCard circuits={circuits} manifoldConnections={manifoldConnections} />
          <div className="panel">
            <ShapeListPanel
            title="Rooms (dimensions in meters)"
            items={roomSummaries}
            emptyMessage="Click two opposite corners on the canvas to draw a rectangular room."
            onDimensionChange={handleRoomDimensionChange}
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
            <CircuitSummary circuits={circuits} manifoldConnections={manifoldConnections} />
          </div>

          <div className="panel">
            <div className="panel-title">
              <span>Manifold connections</span>
              <span className="panel-subtitle">
                Pipes from manifold to circuit inlets
              </span>
            </div>
            {drawMode === "add-connection" && (
              <p style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
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
                      <span style={{ fontSize: 13 }}>{circuitName}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setManifoldConnections((prev) =>
                            prev.filter((c) => c.circuitId !== conn.circuitId)
                          )
                        }
                        style={{ fontSize: 11, padding: "2px 6px" }}
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
              <span>Manifold position (m)</span>
            </div>
            {manifoldPosition ? (
              <div style={{ marginTop: 8, display: "flex", gap: "0.5rem" }}>
                <label>
                  <span style={{ marginRight: 4 }}>X</span>
                  <input
                    type="number"
                    value={
                      manifoldEditingKey === "x"
                        ? manifoldEditingValue
                        : manifoldPosition.x
                    }
                    onFocus={() => {
                      setManifoldEditingKey("x");
                      setManifoldEditingValue(String(manifoldPosition.x));
                    }}
                    onChange={(e) => {
                      if (manifoldEditingKey === "x") {
                        setManifoldEditingValue(e.target.value);
                      }
                    }}
                    onBlur={() => {
                      if (manifoldEditingKey === "x") {
                        const n = Number(manifoldEditingValue);
                        if (Number.isFinite(n)) {
                          setManifoldPosition({
                            x: n,
                            y: manifoldPosition.y
                          });
                        }
                        setManifoldEditingKey(null);
                      }
                    }}
                  />
                </label>
                <label>
                  <span style={{ marginRight: 4 }}>Y</span>
                  <input
                    type="number"
                    value={
                      manifoldEditingKey === "y"
                        ? manifoldEditingValue
                        : manifoldPosition.y
                    }
                    onFocus={() => {
                      setManifoldEditingKey("y");
                      setManifoldEditingValue(String(manifoldPosition.y));
                    }}
                    onChange={(e) => {
                      if (manifoldEditingKey === "y") {
                        setManifoldEditingValue(e.target.value);
                      }
                    }}
                    onBlur={() => {
                      if (manifoldEditingKey === "y") {
                        const n = Number(manifoldEditingValue);
                        if (Number.isFinite(n)) {
                          setManifoldPosition({
                            x: manifoldPosition.x,
                            y: n
                          });
                        }
                        setManifoldEditingKey(null);
                      }
                    }}
                  />
                </label>
              </div>
            ) : (
              <div className="panel-empty">
                Switch to “Manifold” mode and click on the canvas to place it.
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
};


