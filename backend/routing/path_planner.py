from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Tuple
import math

from shapely.geometry import (
    LineString,
    MultiPoint,
    Point as ShapelyPoint,
    Polygon as ShapelyPolygon,
)
from shapely.ops import split

from ..models.circuit import Circuit
from ..models.floorplan import Manifold, Point, Polyline, Polygon
from ..models.heating_zone import HeatingZone


def _build_spiral_full_path(
    zone: HeatingZone,
    manifold: Manifold,
    spacing_m: float,
    max_circuit_length_m: float,
    params: RoutingParams,
) -> Tuple[LineString, LineString, float, float, int] | None:
    """
    Build the full spiral path (inward + outward) for a rectangular zone.
    Returns (full_path, inward, total_path_len, max_stub_one_way, required_circuits)
    or None if the zone is not valid for spiral.
    """
    pts = zone.geometry.boundary.points
    if len(pts) < 4:
        return None

    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    left, right = min(xs), max(xs)
    top, bottom = min(ys), max(ys)

    left += params.wall_clearance_m
    right -= params.wall_clearance_m
    top += params.wall_clearance_m
    bottom -= params.wall_clearance_m

    if right <= left or bottom <= top:
        return None

    spiral_points: List[Tuple[float, float]] = []
    cur_left, cur_right = left, right
    cur_top, cur_bottom = top, bottom

    spiral_points.append((cur_right, cur_bottom))

    while True:
        spiral_points.extend(
            [
                (cur_left, cur_bottom),
                (cur_left, cur_top),
                (cur_right, cur_top),
            ]
        )
        next_left = cur_left + 2 * spacing_m
        next_right = cur_right - 2 * spacing_m
        next_top = cur_top + 2 * spacing_m
        next_bottom = cur_bottom - 2 * spacing_m

        if next_right <= next_left or next_bottom <= next_top:
            center_x = 0.5 * (cur_left + cur_right)
            center_y = 0.5 * (cur_top + cur_bottom)
            spiral_points.append((center_x, center_y))
            break

        spiral_points.extend(
            [
                (cur_right, next_bottom),
                (next_right, next_bottom),
            ]
        )
        cur_left, cur_right = next_left, next_right
        cur_top, cur_bottom = next_top, next_bottom

    inward = LineString(spiral_points)
    if inward.length <= 0:
        return None

    rev = list(reversed(spiral_points))
    n_rev = len(rev)
    outward_points: List[Tuple[float, float]] = []
    for i in range(n_rev):
        x, y = rev[i][0], rev[i][1]
        if i < n_rev - 1:
            dx = rev[i + 1][0] - x
            dy = rev[i + 1][1] - y
        else:
            dx = x - rev[i - 1][0]
            dy = y - rev[i - 1][1]
        length = (dx * dx + dy * dy) ** 0.5
        if length > 1e-9:
            nx = dy / length
            ny = -dx / length
            x += spacing_m * nx
            y += spacing_m * ny
        outward_points.append((x, y))
    outward = LineString(outward_points)
    full_path = LineString(list(inward.coords) + list(outward.coords))

    total_path_len = full_path.length
    if total_path_len <= 0:
        return None

    max_stub_one_way = 0.0
    for x, y in full_path.coords:
        d = math.hypot(x - manifold.position.x, y - manifold.position.y)
        max_stub_one_way = max(max_stub_one_way, d)

    if max_circuit_length_m > 0:
        effective_room_max = max_circuit_length_m - 2.0 * max_stub_one_way
        if effective_room_max <= 0:
            required_circuits = 1
        else:
            required_circuits = max(
                1, math.ceil(total_path_len / effective_room_max)
            )
    else:
        required_circuits = 1

    return (full_path, inward, total_path_len, max_stub_one_way, required_circuits)


def get_spiral_required_circuits_for_zone(
    zone: HeatingZone,
    manifold: Manifold,
    spacing_m: float,
    max_circuit_length_m: float,
    params: RoutingParams | None = None,
) -> int:
    """
    Return the number of circuits required for this zone based on the full
    spiral path length (inward + outward). Used to decide subzone count so
    that subzone calculation is based on total length of one zone, not area.
    """
    if params is None:
        params = RoutingParams()
    result = _build_spiral_full_path(
        zone, manifold, spacing_m, max_circuit_length_m, params
    )
    if result is None:
        return 1
    return result[4]  # required_circuits


def split_zone_into_subzones(zone_geometry: Polygon, n: int) -> List[Polygon]:
    """
    Split a zone's geometry into n equal-area subzones (axis-aligned strips).

    Uses the axis-aligned bounding box; splits along the longer side so each
    subzone is a rectangle. Returns n polygons in order.
    """
    if n <= 1:
        return [zone_geometry]
    pts = zone_geometry.boundary.points
    if not pts:
        return [zone_geometry]
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    left, right = min(xs), max(xs)
    bottom, top = min(ys), max(ys)
    w = right - left
    h = top - bottom
    if w <= 0 or h <= 0:
        return [zone_geometry]

    subzones: List[Polygon] = []
    if w >= h:
        # Split along x into vertical strips.
        for i in range(n):
            x0 = left + w * i / n
            x1 = left + w * (i + 1) / n
            subzones.append(
                Polygon(
                    boundary=Polyline(
                        points=[
                            Point(x=x0, y=bottom),
                            Point(x=x1, y=bottom),
                            Point(x=x1, y=top),
                            Point(x=x0, y=top),
                            Point(x=x0, y=bottom),
                        ]
                    )
                )
            )
    else:
        # Split along y into horizontal strips.
        for i in range(n):
            y0 = bottom + h * i / n
            y1 = bottom + h * (i + 1) / n
            subzones.append(
                Polygon(
                    boundary=Polyline(
                        points=[
                            Point(x=left, y=y0),
                            Point(x=right, y=y0),
                            Point(x=right, y=y1),
                            Point(x=left, y=y1),
                            Point(x=left, y=y0),
                        ]
                    )
                )
            )
    return subzones


from .geometry import (
    generate_parallel_lines,
    inset_polygon,
    polygon_to_shapely,
    shapely_to_polyline,
    subtract_obstacles,
)


@dataclass
class RoutingParams:
    wall_clearance_m: float = 0.10
    min_bend_radius_m: float = 0.15
    main_axis_angle_deg: float = 0.0


def _segments_from_fill_polygon(
    fill_poly: ShapelyPolygon,
    spacing_m: float,
    angle_deg: float,
) -> List[LineString]:
    bbox = fill_poly.envelope
    raw_lines = generate_parallel_lines(
        bbox=bbox,
        spacing_m=spacing_m,
        angle_deg=angle_deg,
    )
    segments: List[LineString] = []
    for line in raw_lines:
        inter = fill_poly.intersection(line)
        if inter.is_empty:
            continue
        if isinstance(inter, LineString):
            segments.append(inter)
        else:
            segments.extend(
                g for g in inter.geoms if isinstance(g, LineString)
            )
    # Order segments from one side to the other to get meander.
    segments.sort(key=lambda s: s.centroid.y)
    return segments


def _build_meander_path(segments: List[LineString]) -> LineString:
    """
    Connect segments in a serpentine (meander) pattern.
    """
    if not segments:
        return LineString()

    ordered_points: List[Tuple[float, float]] = []
    reverse = False
    for seg in segments:
        coords = list(seg.coords)
        if reverse:
            coords.reverse()
        ordered_points.extend(coords)
        reverse = not reverse
    # Simple duplicate removal
    if not ordered_points:
        return LineString()
    dedup: List[Tuple[float, float]] = [ordered_points[0]]
    for x, y in ordered_points[1:]:
        if (x, y) != dedup[-1]:
            dedup.append((x, y))
    return LineString(dedup)


def _split_into_circuits(
    path: LineString,
    circuit_lengths: List[float],
) -> List[LineString]:
    """
    Split a continuous path into subpaths with approximate target lengths.
    """
    if path.length <= 0 or not circuit_lengths:
        return []

    cuts: List[float] = []
    accum = 0.0
    for target in circuit_lengths[:-1]:
        accum += target
        if accum < path.length:
            cuts.append(accum)

    if not cuts:
        return [path]

    split_points = [path.interpolate(d) for d in cuts]
    splitter = MultiPoint(split_points)
    parts = split(path, splitter)

    # In Shapely 2.x, split() returns a GeometryCollection which is not directly
    # iterable; use its .geoms sequence. In older versions, the return value is
    # already iterable. Handle both.
    geoms = getattr(parts, "geoms", parts)
    return [p for p in geoms if isinstance(p, LineString)]


def plan_meander_circuits_for_zone(
    zone: HeatingZone,
    manifold: Manifold,
    spacing_m: float,
    circuit_lengths: List[float],
    obstacles: Iterable[Polygon],
    params: RoutingParams | None = None,
    subzone_index: int | None = None,
) -> List[Circuit]:
    """
    Generate meander circuits for a zone given target circuit lengths.

    This is a geometric approximation that tries to maintain spacing and
    length balance; it does not do detailed hydraulic optimisation.
    """
    if params is None:
        params = RoutingParams()

    # Clearance and obstacle removal.
    inset = inset_polygon(zone.geometry, inset_m=params.wall_clearance_m)
    fill_polys = subtract_obstacles(inset, obstacles)
    if not fill_polys:
        return []

    # For now, assume a single polygon per zone for routing.
    main = polygon_to_shapely(fill_polys[0])
    segments = _segments_from_fill_polygon(
        fill_poly=main,
        spacing_m=spacing_m,
        angle_deg=params.main_axis_angle_deg,
    )
    meander_path = _build_meander_path(segments)
    if meander_path.length <= 0:
        return []

    # Split into circuits; adjust to start/end at manifold by prepending/append
    # a straight link (approximation).
    parts = _split_into_circuits(meander_path, circuit_lengths=circuit_lengths)
    circuits: List[Circuit] = []
    man_x, man_y = manifold.position.x, manifold.position.y

    for idx, part in enumerate(parts):
        start_x, start_y = part.coords[0]
        end_x, end_y = part.coords[-1]
        dist_start = ((start_x - man_x) ** 2 + (start_y - man_y) ** 2) ** 0.5
        dist_end = ((end_x - man_x) ** 2 + (end_y - man_y) ** 2) ** 0.5
        coords_on_part = list(part.coords)
        if dist_start <= dist_end:
            path_coords = coords_on_part
        else:
            path_coords = list(reversed(coords_on_part))
        # Route is in-zone path only; inlet/outlet pipes are drawn manually in the UI.
        in_zone_path = LineString(path_coords)
        polyline = shapely_to_polyline(in_zone_path)
        return_segment_indices: List[int] = []

        circuit_id = (
            f"{zone.id}_sz{subzone_index}_c{idx+1}"
            if subzone_index is not None
            else f"{zone.id}_c{idx+1}"
        )
        circuits.append(
            Circuit(
                id=circuit_id,
                name=f"{zone.name} circuit {idx+1}",
                storey_id=zone.storey_id,
                manifold_id=manifold.id,
                zone_id=zone.id,
                subzone_index=subzone_index if subzone_index is not None else idx,
                spacing_m=spacing_m,
                route=polyline,
                return_segment_indices=return_segment_indices,
                total_length_m=float(in_zone_path.length),
            )
        )

    return circuits


def plan_spiral_circuits_for_rectangle(
    zone: HeatingZone,
    manifold: Manifold,
    spacing_m: float,
    max_circuit_length_m: float,
    params: RoutingParams | None = None,
    subzone_index: int | None = None,
) -> List[Circuit]:
    """
    Plan circuits for a (roughly) rectangular zone using a spiral pattern.

    The spiral starts near the outer perimeter and walks inward by spacing,
    then returns outward along the same trace. The resulting long polyline
    is then split into multiple circuits, each connected back to the manifold.
    """
    if params is None:
        params = RoutingParams()

    result = _build_spiral_full_path(
        zone, manifold, spacing_m, max_circuit_length_m, params
    )
    if result is None:
        return []

    full_path, inward, total_path_len, _max_stub_one_way, required_circuits = result

    target_len = total_path_len / required_circuits
    circuit_lengths = [target_len for _ in range(required_circuits)]

    # Split into circuits of approximate target lengths based on the actual
    # geometric path length rather than the area-based estimate.
    parts = _split_into_circuits(full_path, circuit_lengths=circuit_lengths)
    circuits: List[Circuit] = []
    man_x, man_y = manifold.position.x, manifold.position.y

    for idx, part in enumerate(parts):
        start_x, start_y = part.coords[0]
        end_x, end_y = part.coords[-1]
        dist_start = ((start_x - man_x) ** 2 + (start_y - man_y) ** 2) ** 0.5
        dist_end = ((end_x - man_x) ** 2 + (end_y - man_y) ** 2) ** 0.5
        coords_on_part = list(part.coords)
        if dist_start <= dist_end:
            path_coords = coords_on_part
        else:
            path_coords = list(reversed(coords_on_part))
        # Route is in-zone path only; inlet/outlet pipes are drawn manually in the UI.
        circuit_path = LineString(path_coords)
        polyline = shapely_to_polyline(circuit_path)
        return_segment_indices: List[int] = []
        inward_len = inward.length
        num_points = len(polyline.points)
        for seg_idx in range(num_points - 1):
            p0 = polyline.points[seg_idx]
            p1 = polyline.points[seg_idx + 1]
            mid_x = 0.5 * (p0.x + p1.x)
            mid_y = 0.5 * (p0.y + p1.y)
            mid_pt = ShapelyPoint(mid_x, mid_y)
            d_along_full = full_path.project(mid_pt)
            if d_along_full >= inward_len:
                return_segment_indices.append(seg_idx)

        # Total circuit length: simple spiral = two pipes (supply + return) at
        # pipe spacing * 2 (bifilar), so in-zone length is already centerline * 2.
        # Total = in_zone_both_pipes + 2*stub (same formula as max_circuit_length_m).
        stub_one_way = min(dist_start, dist_end)
        in_zone_both_pipes = float(circuit_path.length)  # supply + return (×2)
        total_circuit_length = in_zone_both_pipes + 2.0 * stub_one_way

        circuit_id = (
            f"{zone.id}_sz{subzone_index}_spiral_c{idx+1}"
            if subzone_index is not None
            else f"{zone.id}_spiral_c{idx+1}"
        )
        circuits.append(
            Circuit(
                id=circuit_id,
                name=f"{zone.name} circuit {idx+1}",
                storey_id=zone.storey_id,
                manifold_id=manifold.id,
                zone_id=zone.id,
                subzone_index=subzone_index if subzone_index is not None else idx,
                spacing_m=spacing_m,
                route=polyline,
                return_segment_indices=return_segment_indices,
                total_length_m=total_circuit_length,
            )
        )

    return circuits

