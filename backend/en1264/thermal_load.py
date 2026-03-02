from __future__ import annotations

from dataclasses import dataclass

from ..models.heating_zone import HeatingZone


@dataclass
class ZoneThermalResult:
    zone_id: str
    area_m2: float
    design_heat_load_w: float
    max_floor_output_w: float
    feasible: bool


def estimate_zone_area(zone: HeatingZone) -> float:
    """Approximate polygon area using the shoelace formula."""
    pts = zone.geometry.boundary.points
    if len(pts) < 3:
        return 0.0
    area = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i].x, pts[i].y
        x2, y2 = pts[(i + 1) % len(pts)].x, pts[(i + 1) % len(pts)].y
        area += x1 * y2 - x2 * y1
    return abs(area) * 0.5


def compute_design_heat_load(zone: HeatingZone, default_u_w_per_m2k: float = 0.8) -> float:
    """
    Very simplified heat load estimate if none is provided.

    Q = A * U * ΔT
    where ΔT is indoor minus outdoor temperature.
    """
    if zone.design_heat_load_w is not None:
        return zone.design_heat_load_w

    area = estimate_zone_area(zone)
    delta_t = zone.design_indoor_temp_c - zone.design_outdoor_temp_c
    return area * default_u_w_per_m2k * delta_t


def compute_max_floor_output(zone: HeatingZone) -> float:
    """
    Compute an approximate maximum floor heat output for the zone.

    This uses a simplified relation:
    q_max ≈ (T_floor_max - T_room) / (R_covering + R_convective)
    with a fixed convective resistance representing slab + surface transfer.
    """
    area = estimate_zone_area(zone)
    if area <= 0.0:
        return 0.0

    t_floor_max = zone.max_floor_surface_temp_c
    t_room = zone.design_indoor_temp_c

    # Very rough combined resistance for slab + surface transfer.
    r_convective = 0.10  # m²K/W, ballpark
    r_total = zone.floor_covering_resistance_m2k_per_w + r_convective
    if r_total <= 0:
        return 0.0

    q_density = (t_floor_max - t_room) / r_total  # W/m²
    if q_density < 0:
        q_density = 0.0

    return q_density * area


def evaluate_zone_thermal_feasibility(zone: HeatingZone) -> ZoneThermalResult:
    """Return basic thermal feasibility data for a zone."""
    area = estimate_zone_area(zone)
    design_heat = compute_design_heat_load(zone)
    max_output = compute_max_floor_output(zone)
    feasible = design_heat <= max_output + 1e-6
    return ZoneThermalResult(
        zone_id=zone.id,
        area_m2=area,
        design_heat_load_w=design_heat,
        max_floor_output_w=max_output,
        feasible=feasible,
    )

