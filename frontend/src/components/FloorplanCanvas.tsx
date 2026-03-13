import React, { forwardRef, MouseEvent, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };

type CircuitPath = {
  id: string;
  points: Point[];
};

type RoomPath = {
  id: string;
  points: Point[];
  name?: string;
};

type ZonePath = {
  id: string;
  points: Point[];
  name?: string;
};

type ManifoldConnection = {
  circuitId: string;
  points: Point[];
};

type Props = {
  floorplanImageUrl?: string;
  circuits: CircuitPath[];
  rooms: RoomPath[];
  tempRoom?: RoomPath | null;
  zones?: ZonePath[];
  tempZone?: ZonePath | null;
  pixelsPerMeter: number;
  drawMode?: string;
  /** When true, shifts content so its top-left bounds start at the canvas origin. Useful for printing. */
  alignTopLeft?: boolean;
  onCanvasClick?: (pointMeters: Point) => void;
  onCanvasMouseDown?: (pointMeters: Point) => void;
  onCanvasMove?: (pointMeters: Point) => void;
  /** Multiple manifolds per floor. */
  manifolds?: { id: string; position: Point; name?: string }[];
  /** When in move-manifold mode, called when user starts dragging a manifold. */
  onManifoldMouseDown?: (manifoldId: string) => void;
  onRoomMouseDown?: (roomId: string, pointMeters: Point) => void;
  onZoneMouseDown?: (zoneId: string, pointMeters: Point) => void;
  onRoomCornerMouseDown?: (roomId: string, cornerIndex: number, pointMeters: Point) => void;
  onZoneCornerMouseDown?: (zoneId: string, cornerIndex: number, pointMeters: Point) => void;
  manifoldConnections?: ManifoldConnection[];
  connectionDrawing?: Point[] | null;
  connectionStartCircuitId?: string | null;
  onConnectionStartAtManifold?: (manifoldId: string, point: Point) => void;
  onConnectionStartAtInlet?: (circuitId: string, point: Point) => void;
  onFinishConnectionAtManifold?: (manifoldId: string) => void;
  onConnectionFinishAtInlet?: (circuitId: string, point: Point) => void;
  onConnectionAddPoint?: (point: Point) => void;
  circuitInletOverrides?: Record<string, Point>;
  circuitIdToZoneId?: Record<string, string>;
  /** Per-circuit 4-point rect to constrain inlet to (subzone or zone border). */
  circuitIdToInletConstraintRect?: Record<string, Point[]>;
  onInletOverrideChange?: (circuitId: string, point: Point) => void;
  /** Grid step in meters for connection waypoints (e.g. 0.05 for 5cm spacing). */
  connectionGridM?: number;
};

export type FloorplanCanvasHandle = {
  getCenterPlanOffset: () => { offset: Point } | null;
  resetPan: () => void;
};

const HANDLE_R = 6;
const CONNECTION_POINT_R = 5;
const CONNECTION_HIT_M = 0.10; /* only snap to manifold/inlet when click is very close; otherwise add waypoint */

/** Snap a free point to the only orthogonal option from `from`: either (from.x, to.y) or (to.x, from.y), whichever is closer to `to`. */
function snapToOrthogonal(from: Point, to: Point): Point {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return dx <= dy ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
}

function snapToGrid(p: Point, gridM: number): Point {
  return {
    x: Math.round(p.x / gridM) * gridM,
    y: Math.round(p.y / gridM) * gridM
  };
}

/** Closest point on the rectangle perimeter (4 edges). `rect` has at least 4 corners in order. */
function closestPointOnRectPerimeter(rect: Point[], p: Point): Point {
  let best: Point = rect[0]!;
  let bestDist = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = rect[i]!;
    const b = rect[(i + 1) % 4]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = q;
    }
  }
  return best;
}

export const FloorplanCanvas = forwardRef<FloorplanCanvasHandle, Props>(function FloorplanCanvas({
  floorplanImageUrl,
  circuits,
  rooms,
  tempRoom,
  zones = [],
  tempZone,
  pixelsPerMeter,
  drawMode = "create-room",
  alignTopLeft = false,
  onCanvasClick,
  onCanvasMouseDown,
  onCanvasMove,
  manifolds = [],
  onManifoldMouseDown,
  onRoomMouseDown,
  onZoneMouseDown,
  onRoomCornerMouseDown,
  onZoneCornerMouseDown,
  manifoldConnections = [],
  connectionDrawing = null,
  connectionStartCircuitId = null,
  onConnectionStartAtManifold,
  onConnectionStartAtInlet,
  onFinishConnectionAtManifold,
  onConnectionFinishAtInlet,
  onConnectionAddPoint,
  circuitInletOverrides = {},
  circuitIdToZoneId = {},
  circuitIdToInletConstraintRect = {},
  onInletOverrideChange,
  connectionGridM = 0.05
}, ref) {
  const isEditRooms = drawMode === "edit-rooms";
  const isEditZones = drawMode === "edit-zones";
  const isAddConnection = drawMode === "add-connection";
  const isMoveInlet = drawMode === "move-inlet";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [cursorMeters, setCursorMeters] = useState<Point | null>(null);
  const [inletDrag, setInletDrag] = useState<{ circuitId: string } | null>(null);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });

  useEffect(() => {
    if (!inletDrag) return;
    const up = () => setInletDrag(null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [inletDrag]);

  useEffect(() => {
    if (!isMoveInlet) setInletDrag(null);
  }, [isMoveInlet]);

  const toPoint = (clientX: number, clientY: number): Point | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const xPx = clientX - rect.left - pan.x;
    const yPx = clientY - rect.top - pan.y;
    return {
      x: xPx / pixelsPerMeter,
      y: yPx / pixelsPerMeter
    };
  };

  const getContentBoundsMeters = (): { minX: number; minY: number; maxX: number; maxY: number } | null => {
    const allPoints: Point[] = [];
    for (const r of rooms) allPoints.push(...r.points);
    for (const z of zones) allPoints.push(...z.points);
    for (const c of circuits) allPoints.push(...c.points);
    for (const m of manifolds) allPoints.push(m.position);
    if (tempRoom) allPoints.push(...tempRoom.points);
    if (tempZone) allPoints.push(...tempZone.points);
    if (connectionDrawing) allPoints.push(...connectionDrawing);
    for (const conn of manifoldConnections) allPoints.push(...conn.points);
    if (allPoints.length === 0) return null;
    const xs = allPoints.map((p) => p.x);
    const ys = allPoints.map((p) => p.y);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys)
    };
  };

  const getCenterPlanOffset = (): { offset: Point } | null => {
    const el = containerRef.current;
    const bounds = getContentBoundsMeters();
    if (!el || !bounds) return null;
    const rect = el.getBoundingClientRect();
    const viewportCenterMeters: Point = {
      x: rect.width / 2 / pixelsPerMeter,
      y: rect.height / 2 / pixelsPerMeter
    };
    const contentCenterMeters: Point = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2
    };
    return {
      offset: {
        x: viewportCenterMeters.x - contentCenterMeters.x,
        y: viewportCenterMeters.y - contentCenterMeters.y
      }
    };
  };

  const resetPan = () => setPan({ x: 0, y: 0 });

  useImperativeHandle(ref, () => ({ getCenterPlanOffset, resetPan }), [getCenterPlanOffset]);

  const contentHeightPx = useMemo(() => {
    const bounds = getContentBoundsMeters();
    if (!bounds) return null;
    return (bounds.maxY - bounds.minY) * pixelsPerMeter;
  }, [rooms, zones, circuits, manifolds, tempRoom, tempZone, connectionDrawing, manifoldConnections, pixelsPerMeter]);

  const canvasMinHeight = 600;
  const canvasHeight =
    contentHeightPx != null && contentHeightPx > 0
      ? `max(80vh, ${canvasMinHeight}px, ${contentHeightPx + 80}px)`
      : `max(80vh, ${canvasMinHeight}px)`;

  const alignOffsetPx: Point = useMemo(() => {
    if (!alignTopLeft) return { x: 0, y: 0 };
    const bounds = getContentBoundsMeters();
    if (!bounds) return { x: 0, y: 0 };
    const marginPx = 8;
    return {
      x: -bounds.minX * pixelsPerMeter + marginPx,
      y: -bounds.minY * pixelsPerMeter + marginPx
    };
  }, [
    alignTopLeft,
    rooms,
    zones,
    circuits,
    manifolds,
    tempRoom,
    tempZone,
    connectionDrawing,
    manifoldConnections,
    pixelsPerMeter
  ]);

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const p = toPoint(e.clientX, e.clientY);
    if (!p) return;
    if (isAddConnection) {
      const hasPoints = connectionDrawing && connectionDrawing.length >= 1;
      for (const m of manifolds) {
        const distManifold = Math.hypot(p.x - m.position.x, p.y - m.position.y);
        if (distManifold <= CONNECTION_HIT_M) {
          e.stopPropagation();
          if (!hasPoints) {
            onConnectionStartAtManifold?.(m.id, m.position);
          } else if (connectionStartCircuitId) {
            onFinishConnectionAtManifold?.(m.id);
          }
          return;
        }
      }
      for (const circuit of circuits) {
        if (circuit.points.length < 2) continue;
        const inletPos = circuitInletOverrides[circuit.id] ?? circuit.points[0]!;
        const distFirst = Math.hypot(p.x - inletPos.x, p.y - inletPos.y);
        if (distFirst <= CONNECTION_HIT_M) {
          e.stopPropagation();
          if (!hasPoints) {
            onConnectionStartAtInlet?.(circuit.id, inletPos);
          } else {
            onConnectionFinishAtInlet?.(circuit.id, inletPos);
          }
          return;
        }
      }
      if (hasPoints && onConnectionAddPoint) {
        e.stopPropagation();
        onConnectionAddPoint(p);
        return;
      }
      return;
    }
    if (onCanvasClick) onCanvasClick(p);
  };

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const p = toPoint(e.clientX, e.clientY);
    if (!p) return;
    if (onCanvasMouseDown) onCanvasMouseDown(p);
  };

  const handleMove = (e: MouseEvent<HTMLDivElement>) => {
    const p = toPoint(e.clientX, e.clientY);
    if (inletDrag && p && onInletOverrideChange) {
      const rect =
        circuitIdToInletConstraintRect[inletDrag.circuitId] ??
        (() => {
          const zoneId = circuitIdToZoneId[inletDrag.circuitId];
          const zone = zones.find((z) => z.id === zoneId);
          return zone && zone.points.length >= 4 ? zone.points.slice(0, 4) : null;
        })();
      if (rect && rect.length >= 4) {
        const projected = closestPointOnRectPerimeter(rect, p);
        onInletOverrideChange(inletDrag.circuitId, projected);
      }
    }
    if (
      p &&
      isAddConnection &&
      connectionDrawing &&
      connectionDrawing.length >= 1
    ) {
      setCursorMeters(p);
    } else {
      setCursorMeters(null);
    }
    if (!onCanvasMove) return;
    if (!p) return;
    onCanvasMove(p);
  };

  const toSvgPath = (points: Point[]) => {
    if (points.length === 0) return "";
    return `M ${points
      .map((p) => `${p.x * pixelsPerMeter},${p.y * pixelsPerMeter}`)
      .join(" L ")}`;
  };

  return (
    <div
      style={{
        border: "1px solid #ddd",
        position: "relative",
        minHeight: canvasMinHeight,
        height: canvasHeight
      }}
      ref={containerRef}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMove}
    >
      {floorplanImageUrl && (
        <img
          src={floorplanImageUrl}
          alt="Floorplan"
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      )}
      <svg
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible"
        }}
      >
        <g transform={`translate(${pan.x + alignOffsetPx.x}, ${pan.y + alignOffsetPx.y})`}>
        {manifolds.map((m) => {
          const isMoveManifold = drawMode === "move-manifold";
          return (
            <circle
              key={m.id}
              cx={m.position.x * pixelsPerMeter}
              cy={m.position.y * pixelsPerMeter}
              r={6}
              fill="#e76f51"
              stroke="#000"
              strokeWidth={1}
              style={{
                cursor: isMoveManifold ? "grab" : "default",
                pointerEvents: isMoveManifold ? "auto" : "none"
              }}
              onMouseDown={
                isMoveManifold && onManifoldMouseDown
                  ? (e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onManifoldMouseDown(m.id);
                    }
                  : undefined
              }
            />
          );
        })}
        {rooms.map((room) => {
          const pathD = toSvgPath(room.points);
          const xs = room.points.map((p) => p.x * pixelsPerMeter);
          const ys = room.points.map((p) => p.y * pixelsPerMeter);
          const minX = xs.length ? Math.min(...xs) : 0;
          const maxX = xs.length ? Math.max(...xs) : 0;
          const minY = ys.length ? Math.min(...ys) : 0;
          const labelX = (minX + maxX) / 2;
          const labelY = minY - 14;
          const handleRoomDown = (e: React.MouseEvent<SVGGElement>) => {
            if (!isEditRooms || !onRoomMouseDown) return;
            e.stopPropagation();
            e.preventDefault();
            const p = toPoint(e.clientX, e.clientY);
            if (!p) return;
            onRoomMouseDown(room.id, p);
          };

          return (
            <g key={room.id}>
              <path
                d={pathD}
                stroke="#264653"
                strokeWidth={2}
                fill="rgba(38, 70, 83, 0.05)"
                onMouseDown={handleRoomDown}
              />
              {room.name && (
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                  dominantBaseline="hanging"
                  fontSize={14}
                  fill="#264653"
                >
                  {room.name}
                </text>
              )}
              {isEditRooms && room.points.length >= 4 && [0, 1, 2, 3].map((i) => {
                const pt = room.points[i];
                if (!pt) return null;
                const cx = pt.x * pixelsPerMeter;
                const cy = pt.y * pixelsPerMeter;
                const onCornerDown = (e: React.MouseEvent<SVGCircleElement>) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const p = toPoint(e.clientX, e.clientY);
                  if (!p || !onRoomCornerMouseDown) return;
                  onRoomCornerMouseDown(room.id, i, p);
                };
                return (
                  <circle
                    key={`${room.id}-${i}`}
                    cx={cx}
                    cy={cy}
                    r={HANDLE_R}
                    fill="#264653"
                    stroke="#fff"
                    strokeWidth={1.5}
                    style={{ cursor: "move" }}
                    onMouseDown={onCornerDown}
                  />
                );
              })}
            </g>
          );
        })}
        {zones.map((zone) => {
          const pathD = toSvgPath(zone.points);
          const xs = zone.points.map((p) => p.x * pixelsPerMeter);
          const ys = zone.points.map((p) => p.y * pixelsPerMeter);
          const maxX = xs.length ? Math.max(...xs) : 0;
          const minY = ys.length ? Math.min(...ys) : 0;
          const maxY = ys.length ? Math.max(...ys) : 0;
          const labelX = maxX + 8;
          const labelY = (minY + maxY) / 2;
          const handleZoneDown = (e: React.MouseEvent<SVGGElement>) => {
            if (!isEditZones || !onZoneMouseDown) return;
            e.stopPropagation();
            e.preventDefault();
            const p = toPoint(e.clientX, e.clientY);
            if (!p) return;
            onZoneMouseDown(zone.id, p);
          };

          return (
            <g key={zone.id}>
              <path
                d={pathD}
                stroke="#2a9d8f"
                strokeWidth={2}
                fill="rgba(42, 157, 143, 0.08)"
                onMouseDown={handleZoneDown}
              />
              {zone.name && (
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor="start"
                  dominantBaseline="middle"
                  fontSize={14}
                  fill="#000"
                >
                  {zone.name}
                </text>
              )}
              {isEditZones && zone.points.length >= 4 && [0, 1, 2, 3].map((i) => {
                const pt = zone.points[i];
                if (!pt) return null;
                const cx = pt.x * pixelsPerMeter;
                const cy = pt.y * pixelsPerMeter;
                const onCornerDown = (e: React.MouseEvent<SVGCircleElement>) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const p = toPoint(e.clientX, e.clientY);
                  if (!p || !onZoneCornerMouseDown) return;
                  onZoneCornerMouseDown(zone.id, i, p);
                };
                return (
                  <circle
                    key={`${zone.id}-${i}`}
                    cx={cx}
                    cy={cy}
                    r={HANDLE_R}
                    fill="#2a9d8f"
                    stroke="#fff"
                    strokeWidth={1.5}
                    style={{ cursor: "move" }}
                    onMouseDown={onCornerDown}
                  />
                );
              })}
            </g>
          );
        })}
        {tempRoom && tempRoom.points.length > 0 && (() => {
          const first = tempRoom.points[0];
          const last = tempRoom.points[tempRoom.points.length - 1];
          if (!first || !last) return null;
          const x1 = Math.min(first.x, last.x);
          const x2 = Math.max(first.x, last.x);
          const y1 = Math.min(first.y, last.y);
          const y2 = Math.max(first.y, last.y);
          const rectPoints: Point[] = [
            { x: x1, y: y1 },
            { x: x2, y: y1 },
            { x: x2, y: y2 },
            { x: x1, y: y2 },
            { x: x1, y: y1 }
          ];
          const d = toSvgPath(rectPoints);
          return (
            <path
              d={d}
              stroke="#e9c46a"
              strokeWidth={2}
              strokeDasharray="4 4"
              fill="none"
            />
          );
        })()}
        {tempZone && tempZone.points.length > 0 && (() => {
          const first = tempZone.points[0];
          const last = tempZone.points[tempZone.points.length - 1];
          if (!first || !last) return null;
          const x1 = Math.min(first.x, last.x);
          const x2 = Math.max(first.x, last.x);
          const y1 = Math.min(first.y, last.y);
          const y2 = Math.max(first.y, last.y);
          const rectPoints: Point[] = [
            { x: x1, y: y1 },
            { x: x2, y: y1 },
            { x: x2, y: y2 },
            { x: x1, y: y2 },
            { x: x1, y: y1 }
          ];
          const d = toSvgPath(rectPoints);
          return (
            <path
              d={d}
              stroke="#2a9d8f"
              strokeWidth={2}
              strokeDasharray="4 4"
              fill="none"
            />
          );
        })()}
        {manifoldConnections.map((conn, i) => (
          <path
            key={`conn-${conn.circuitId}-${i}`}
            d={toSvgPath(conn.points)}
            stroke="#64748b"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            fill="none"
          />
        ))}
        {connectionDrawing && connectionDrawing.length >= 1 && (
          <>
            <path
              d={toSvgPath(connectionDrawing)}
              stroke="#0f172a"
              strokeWidth={2.5}
              strokeDasharray="4 2"
              fill="none"
            />
            {cursorMeters && (() => {
              const last = connectionDrawing[connectionDrawing.length - 1]!;
              const orth = snapToOrthogonal(last, cursorMeters);
              const previewEnd = connectionGridM > 0 ? snapToGrid(orth, connectionGridM) : orth;
              return (
                <path
                  d={toSvgPath([last, previewEnd])}
                  stroke="#334155"
                  strokeWidth={2.5}
                  strokeDasharray="2 2"
                  fill="none"
                  opacity={0.95}
                />
              );
            })()}
          </>
        )}
        {circuits.map((circuit, index) => {
          const hasInlet = manifoldConnections.some(
            (c) => c.circuitId === circuit.id
          );
          const inletPos = circuitInletOverrides[circuit.id] ?? circuit.points[0];
          const d = toSvgPath(circuit.points);
          const stroke =
            ["#e63946", "#457b9d", "#2a9d8f", "#f4a261"][index % 4];
          const showInlet = circuit.points.length >= 2 && inletPos;
          const canInteractInlet = isAddConnection || isMoveInlet;
          return (
            <g key={circuit.id ? `${circuit.id}-${index}` : `path-${index}`}>
              <path
                d={d}
                stroke={stroke}
                strokeWidth={2}
                fill="none"
                opacity={hasInlet ? 1 : 0.35}
              />
              {showInlet && (
                <circle
                  cx={inletPos!.x * pixelsPerMeter}
                  cy={inletPos!.y * pixelsPerMeter}
                  r={CONNECTION_POINT_R}
                  fill="#fff"
                  stroke="#333"
                  strokeWidth={1.5}
                  style={{
                    cursor: canInteractInlet ? (isMoveInlet ? "grab" : "crosshair") : "default",
                    pointerEvents: canInteractInlet ? "auto" : "none"
                  }}
                  onMouseDown={
                    isMoveInlet
                      ? (e) => {
                          e.stopPropagation();
                          setInletDrag({ circuitId: circuit.id });
                        }
                      : undefined
                  }
                />
              )}
            </g>
          );
        })}
        </g>
      </svg>
    </div>
  );
});


