from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List

from ..models.heating_zone import HeatingZone
from .thermal_load import estimate_zone_area, compute_design_heat_load


@dataclass
class CircuitSizingParams:
    pipe_outer_diameter_mm: float = 16.0
    max_circuit_length_m: float = 100.0
    spacing_options_m: tuple = (0.10, 0.15, 0.20)
    # Optional explicit spacing override supplied by the caller. When set,
    # spacing_options_m is ignored and this spacing is always used.
    fixed_spacing_m: float | None = None


@dataclass
class ZoneCircuitDesign:
    zone_id: str
    spacing_m: float
    total_pipe_length_m: float
    circuit_count: int
    circuit_target_length_m: float
    design_heat_load_w: float
    heat_per_meter_w: float


def estimate_heat_output_per_meter(
    spacing_m: float,
    mean_water_temp_c: float,
    room_temp_c: float,
    pipe_outer_diameter_mm: float,
) -> float:
    """
    Rough estimate of heat output per meter of pipe based on spacing and ΔT.

    This is highly simplified: we assume typical manufacturer behaviour where
    W/m² vs spacing is roughly linear over practical ranges, and convert to W/m.
    """
    if spacing_m <= 0:
        return 0.0

    delta_t = mean_water_temp_c - room_temp_c
    if delta_t <= 0:
        return 0.0

    # Base output density for 0.15 m spacing at ΔT = 10 K (ballpark).
    base_q_density_w_per_m2 = 70.0
    base_spacing_m = 0.15
    base_delta_t_k = 10.0

    q_density = base_q_density_w_per_m2 * (base_spacing_m / spacing_m) * (
        delta_t / base_delta_t_k
    )
    # Convert to W/m using spacing (W/m² * m).
    q_per_meter = q_density * spacing_m
    return q_per_meter


def size_zone_circuits(
    zone: HeatingZone,
    sizing: CircuitSizingParams | None = None,
    mean_water_temp_c: float = 32.5,
) -> ZoneCircuitDesign:
    """
    Decide pipe spacing and number of circuits for a given zone.

    This favours wider spacing where possible, while ensuring the zone heat
    demand can be met and circuit lengths stay within recommended limits.
    """
    if sizing is None:
        sizing = CircuitSizingParams()

    area = estimate_zone_area(zone)
    if area <= 0:
        return ZoneCircuitDesign(
            zone_id=zone.id,
            spacing_m=(
                sizing.fixed_spacing_m
                if sizing.fixed_spacing_m is not None
                else sizing.spacing_options_m[-1]
            ),
            total_pipe_length_m=0.0,
            circuit_count=0,
            circuit_target_length_m=0.0,
            design_heat_load_w=0.0,
            heat_per_meter_w=0.0,
        )

    design_heat = compute_design_heat_load(zone)

    best_design: ZoneCircuitDesign | None = None

    if sizing.fixed_spacing_m is not None:
        spacings = (sizing.fixed_spacing_m,)
    else:
        spacings = tuple(sorted(sizing.spacing_options_m))

    for spacing in spacings:
        # Approximate pipe length needed to cover area at this spacing.
        total_length = area / spacing

        heat_per_meter = estimate_heat_output_per_meter(
            spacing_m=spacing,
            mean_water_temp_c=mean_water_temp_c,
            room_temp_c=zone.design_indoor_temp_c,
            pipe_outer_diameter_mm=sizing.pipe_outer_diameter_mm,
        )
        total_heat_capacity = heat_per_meter * total_length

        if total_heat_capacity < design_heat:
            # This spacing cannot satisfy heat demand; try tighter spacing.
            continue

        circuit_count = max(
            1, math.ceil(total_length / sizing.max_circuit_length_m)
        )
        target_length = total_length / circuit_count

        candidate = ZoneCircuitDesign(
            zone_id=zone.id,
            spacing_m=spacing,
            total_pipe_length_m=total_length,
            circuit_count=circuit_count,
            circuit_target_length_m=target_length,
            design_heat_load_w=design_heat,
            heat_per_meter_w=heat_per_meter,
        )

        if best_design is None:
            best_design = candidate
        else:
            # Prefer fewer circuits / shorter total length.
            if candidate.circuit_count < best_design.circuit_count or (
                candidate.circuit_count == best_design.circuit_count
                and candidate.total_pipe_length_m
                <= best_design.total_pipe_length_m
            ):
                best_design = candidate

    # If no spacing satisfies the load, fall back to tightest spacing.
    if best_design is None:
        spacing = min(sizing.spacing_options_m)
        total_length = area / spacing
        heat_per_meter = estimate_heat_output_per_meter(
            spacing_m=spacing,
            mean_water_temp_c=mean_water_temp_c,
            room_temp_c=zone.design_indoor_temp_c,
            pipe_outer_diameter_mm=sizing.pipe_outer_diameter_mm,
        )
        circuit_count = max(
            1, math.ceil(total_length / sizing.max_circuit_length_m)
        )
        target_length = total_length / circuit_count
        best_design = ZoneCircuitDesign(
            zone_id=zone.id,
            spacing_m=spacing,
            total_pipe_length_m=total_length,
            circuit_count=circuit_count,
            circuit_target_length_m=target_length,
            design_heat_load_w=design_heat,
            heat_per_meter_w=heat_per_meter,
        )

    return best_design


def size_all_zones(
    zones: List[HeatingZone],
    sizing: CircuitSizingParams | None = None,
    mean_water_temp_c: float = 32.5,
) -> List[ZoneCircuitDesign]:
    """Convenience function to size circuits for many zones."""
    return [
        size_zone_circuits(
            zone=zone,
            sizing=sizing,
            mean_water_temp_c=mean_water_temp_c,
        )
        for zone in zones
    ]

