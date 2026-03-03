#!/usr/bin/env python3
"""
Verify spiral total length for a 10 m × 10 m rectangle with 10 cm pipe spacing.

Formula: build inward spiral until collision, then total length = 2 × inward length
(supply + return). Compares this to the planner's in-zone path length.

Run from project root: python backend/scripts/verify_spiral_length.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

# Add backend root so we can import from models and routing.
backend = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend.parent))

from shapely.geometry import LineString

from backend.models.floorplan import Manifold, Point, Polyline, Polygon
from backend.models.heating_zone import HeatingZone
from backend.routing.path_planner import plan_spiral_circuits_for_rectangle


def build_inward_spiral_points(
    left: float, right: float, top: float, bottom: float, spacing_m: float
) -> list[tuple[float, float]]:
    """Build inward spiral points (same logic as path_planner)."""
    spiral_points: list[tuple[float, float]] = []
    cur_left, cur_right = left, right
    cur_top, cur_bottom = top, bottom

    spiral_points.append((cur_right, cur_bottom))

    while True:
        spiral_points.extend([
            (cur_left, cur_bottom),
            (cur_left, cur_top),
            (cur_right, cur_top),
        ])

        next_left = cur_left + 2 * spacing_m
        next_right = cur_right - 2 * spacing_m
        next_top = cur_top + 2 * spacing_m
        next_bottom = cur_bottom - 2 * spacing_m

        if next_right <= next_left or next_bottom <= next_top:
            center_x = 0.5 * (cur_left + cur_right)
            center_y = 0.5 * (cur_top + cur_bottom)
            spiral_points.append((center_x, center_y))
            break

        spiral_points.extend([
            (cur_right, next_bottom),
            (next_right, next_bottom),
        ])
        cur_left, cur_right = next_left, next_right
        cur_top, cur_bottom = next_top, next_bottom

    return spiral_points


def build_outward_offset(
    spiral_points: list[tuple[float, float]], spacing_m: float
) -> LineString:
    """Build outward path as reverse of inward, offset by spacing (same as path_planner)."""
    rev = list(reversed(spiral_points))
    n_rev = len(rev)
    outward_points: list[tuple[float, float]] = []
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
    return LineString(outward_points)


def build_inward_spiral_length(
    left: float, right: float, top: float, bottom: float, spacing_m: float
) -> float:
    """Return inward spiral length only."""
    spiral_points = build_inward_spiral_points(left, right, top, bottom, spacing_m)
    return float(LineString(spiral_points).length)


def polyline_length_m(points: list[Point]) -> float:
    """Total length of polyline (sum of segment lengths)."""
    length = 0.0
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        length += math.hypot(b.x - a.x, b.y - a.y)
    return length


def main() -> None:
    # 10 m × 10 m rectangle (interior after wall clearance 0)
    width_m = 10.0
    height_m = 10.0
    # Place rectangle with bottom-left at (0, 0) for simplicity
    boundary = Polyline(
        points=[
            Point(x=0, y=0),
            Point(x=width_m, y=0),
            Point(x=width_m, y=height_m),
            Point(x=0, y=height_m),
            Point(x=0, y=0),
        ]
    )
    zone_geometry = Polygon(boundary=boundary)

    zone = HeatingZone(
        id="test_zone",
        name="Test zone",
        storey_id="storey_1",
        geometry=zone_geometry,
    )

    # Manifold outside the zone so stub is well-defined (e.g. bottom-left corner)
    manifold = Manifold(
        id="manifold_1",
        storey_id="storey_1",
        position=Point(x=-0.5, y=-0.5),
    )

    spacing_m = 0.10  # 10 cm pipe spacing

    # Apply same inset as path_planner (wall_clearance_m = 0.10 by default)
    from backend.routing.path_planner import RoutingParams
    params = RoutingParams(wall_clearance_m=0.10)
    left = 0.0 + params.wall_clearance_m
    right = width_m - params.wall_clearance_m
    top = 0.0 + params.wall_clearance_m
    bottom = height_m - params.wall_clearance_m

    spiral_points = build_inward_spiral_points(left, right, top, bottom, spacing_m)
    inward = LineString(spiral_points)
    inward_length = float(inward.length)
    outward = build_outward_offset(spiral_points, spacing_m)

    # Formula: total = 2 × inward (supply + return on same centerline).
    total_formula_2x_inward = 2.0 * inward_length
    # Code formula: total = inward.length + outward.length (actual geometry, offset return).
    total_code_formula = float(inward.length) + float(outward.length)

    print("Rectangle (after wall clearance): {:.2f} m × {:.2f} m".format(
        right - left, bottom - top
    ))
    print("Pipe spacing: {:.2f} m".format(spacing_m))
    print()
    print("Inward spiral length: {:.2f} m".format(inward_length))
    print("Formula (2 × inward):              {:.2f} m".format(total_formula_2x_inward))
    print("Code formula (inward + outward):   {:.2f} m".format(total_code_formula))
    print("  Difference (code - 2×inward):   {:.3f} m".format(
        total_code_formula - total_formula_2x_inward
    ))

    # Run planner (single circuit by using large max length)
    circuits = plan_spiral_circuits_for_rectangle(
        zone=zone,
        manifold=manifold,
        spacing_m=spacing_m,
        max_circuit_length_m=5000.0,
        params=params,
    )

    if not circuits:
        print("ERROR: planner returned no circuits")
        sys.exit(1)

    # Sum in-zone path length from all circuits (route length only, no stub)
    total_in_zone_from_planner = 0.0
    for c in circuits:
        route_len = polyline_length_m(c.route.points)
        total_in_zone_from_planner += route_len

    print()
    print("Planner in-zone path length (supply + return): {:.2f} m".format(
        total_in_zone_from_planner
    ))
    print("  vs code formula (inward + outward): diff = {:.3f} m".format(
        total_in_zone_from_planner - total_code_formula
    ))

    # Outward path is offset by spacing, so planner total ≈ 2×inward but not exact.
    # Allow 1% tolerance against formula (2×inward).
    tolerance = max(1.0, total_formula_2x_inward * 0.01)
    diff = abs(total_in_zone_from_planner - total_formula_2x_inward)
    if diff <= tolerance:
        print()
        print("OK: planner in-zone ≈ 2 × inward (diff = {:.3f} m, within {:.1f} m)".format(
            diff, tolerance
        ))
    else:
        print()
        print("MISMATCH: formula 2×inward ~{:.2f} m, planner got {:.2f} m (diff = {:.3f} m)".format(
            total_formula_2x_inward, total_in_zone_from_planner, diff
        ))
        sys.exit(1)


if __name__ == "__main__":
    main()
