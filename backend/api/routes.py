from __future__ import annotations

from typing import List, Tuple

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ..en1264.circuit_sizing import CircuitSizingParams, size_zone_circuits
from ..en1264.thermal_load import ZoneThermalResult, evaluate_zone_thermal_feasibility
from ..models.circuit import Circuit
from ..models.floorplan import Floorplan, Manifold, Polygon
from ..models.heating_zone import HeatingZone
from ..routing.path_planner import (
    RoutingParams,
    plan_meander_circuits_for_zone,
    plan_spiral_circuits_for_rectangle,
    split_zone_into_subzones,
)


app = FastAPI(title="Underfloor Heating Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ProjectDefinition(BaseModel):
    floorplan: Floorplan
    zones: List[HeatingZone]
    manifolds: List[Manifold]


class CalculationParams(BaseModel):
    sizing: CircuitSizingParams | None = None
    routing: RoutingParams | None = None
    pipe_spacing_m: float | None = None
    pipe_spacing_by_zone_id: dict[str, float] | None = None
    max_circuit_length_m: float | None = None


class CalculationResult(BaseModel):
    thermal: List[ZoneThermalResult]
    sizing: List[dict]
    circuits: List[Circuit]


def _polygon_bounds_center(poly: Polygon) -> Tuple[float, float]:
    """Compute the center of an axis‑aligned bounding box for a polygon."""
    if not poly.boundary.points:
        return 0.0, 0.0
    xs = [p.x for p in poly.boundary.points]
    ys = [p.y for p in poly.boundary.points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return (min_x + max_x) / 2.0, (min_y + max_y) / 2.0


@app.post("/projects/calculate", response_model=CalculationResult)
def calculate_layout(
    project: ProjectDefinition,
    params: CalculationParams | None = None,
) -> CalculationResult:
    """
    Perform thermal feasibility, circuit sizing, and basic routing for a project.

    This endpoint expects geometry (floorplan, zones, manifolds) to be pre‑defined
    on the client; it returns zone thermal checks, circuit sizing results, and
    meander circuit paths.
    """
    if params is None:
        params = CalculationParams()

    # Thermal evaluation.
    thermal_results: List[ZoneThermalResult] = [
        evaluate_zone_thermal_feasibility(z) for z in project.zones
    ]

    # Circuit sizing: support per-zone pipe spacing.
    base_sizing = params.sizing or CircuitSizingParams()
    if params.max_circuit_length_m is not None:
        base_sizing.max_circuit_length_m = params.max_circuit_length_m
    spacing_by_zone = params.pipe_spacing_by_zone_id or {}

    sizing_results = []
    for zone in project.zones:
        zone_spacing = spacing_by_zone.get(zone.id)
        if zone_spacing is not None:
            sizing = CircuitSizingParams(
                pipe_outer_diameter_mm=base_sizing.pipe_outer_diameter_mm,
                max_circuit_length_m=base_sizing.max_circuit_length_m,
                spacing_options_m=base_sizing.spacing_options_m,
                fixed_spacing_m=zone_spacing,
            )
        else:
            sizing = CircuitSizingParams(
                pipe_outer_diameter_mm=base_sizing.pipe_outer_diameter_mm,
                max_circuit_length_m=base_sizing.max_circuit_length_m,
                spacing_options_m=base_sizing.spacing_options_m,
                fixed_spacing_m=params.pipe_spacing_m or base_sizing.fixed_spacing_m,
            )
        sizing_results.append(size_zone_circuits(zone=zone, sizing=sizing))

    # Build lookup for manifolds by storey; simple strategy: pick first manifold
    # on same storey as zone.
    manifolds_by_storey: dict[str, List[Manifold]] = {}
    for m in project.manifolds:
        manifolds_by_storey.setdefault(m.storey_id, []).append(m)

    # Pre-compute Manhattan distance from each zone to its nearest manifold
    # on the same storey.
    manhattan_by_zone: dict[str, float] = {}
    for zone in project.zones:
        m_list = manifolds_by_storey.get(zone.storey_id) or []
        if not m_list:
            continue
        manifold = m_list[0]
        cx, cy = _polygon_bounds_center(zone.geometry)
        mx, my = manifold.position.x, manifold.position.y
        manhattan = abs(cx - mx) + abs(cy - my)
        manhattan_by_zone[zone.id] = manhattan

    circuits: List[Circuit] = []
    for zone, sizing in zip(project.zones, sizing_results):
        m_list = manifolds_by_storey.get(zone.storey_id) or []
        if not m_list or sizing.circuit_count <= 0:
            continue

        manifold = m_list[0]

        # Collect obstacles from rooms on same storey whose outlines intersect zone.
        obstacles: List[Polygon] = []
        for storey in project.floorplan.storeys:
            if storey.id != zone.storey_id:
                continue
            for room in storey.rooms:
                obstacles.extend(room.obstacles)

        routing_params = params.routing
        n_circuits = sizing.circuit_count

        # If zone needs more than one circuit, split into N equal subzones (one circuit per subzone).
        if n_circuits > 1:
            subzone_polygons = split_zone_into_subzones(zone.geometry, n_circuits)
            for subzone_index, sub_geometry in enumerate(subzone_polygons):
                subzone = HeatingZone(
                    id=zone.id,
                    name=zone.name,
                    storey_id=zone.storey_id,
                    room_ids=zone.room_ids,
                    geometry=sub_geometry,
                    design_indoor_temp_c=zone.design_indoor_temp_c,
                    design_outdoor_temp_c=zone.design_outdoor_temp_c,
                    floor_covering_resistance_m2k_per_w=zone.floor_covering_resistance_m2k_per_w,
                    max_floor_surface_temp_c=zone.max_floor_surface_temp_c,
                    design_heat_load_w=zone.design_heat_load_w,
                )
                spiral_circuits = plan_spiral_circuits_for_rectangle(
                    zone=subzone,
                    manifold=manifold,
                    spacing_m=sizing.spacing_m,
                    max_circuit_length_m=base_sizing.max_circuit_length_m,
                    params=routing_params,
                    subzone_index=subzone_index,
                )
                if spiral_circuits:
                    circuits.extend(spiral_circuits)
                else:
                    circuits.extend(
                        plan_meander_circuits_for_zone(
                            zone=subzone,
                            manifold=manifold,
                            spacing_m=sizing.spacing_m,
                            circuit_lengths=[sizing.circuit_target_length_m],
                            obstacles=obstacles,
                            params=routing_params,
                            subzone_index=subzone_index,
                        )
                    )
        else:
            spiral_circuits = plan_spiral_circuits_for_rectangle(
                zone=zone,
                manifold=manifold,
                spacing_m=sizing.spacing_m,
                max_circuit_length_m=base_sizing.max_circuit_length_m,
                params=routing_params,
                subzone_index=0,
            )
            if spiral_circuits:
                circuits.extend(spiral_circuits)
            else:
                circuits.extend(
                    plan_meander_circuits_for_zone(
                        zone=zone,
                        manifold=manifold,
                        spacing_m=sizing.spacing_m,
                        circuit_lengths=[sizing.circuit_target_length_m],
                        obstacles=obstacles,
                        params=routing_params,
                        subzone_index=0,
                    )
                )

    # `sizing_results` contains dataclasses; convert to dicts for JSON and
    # attach Manhattan distance per zone where available.
    sizing_payload: List[dict] = []
    for s in sizing_results:
        data = s.__dict__.copy()
        data["manhattan_distance_m"] = manhattan_by_zone.get(s.zone_id)
        sizing_payload.append(data)

    return CalculationResult(
        thermal=thermal_results,
        sizing=sizing_payload,
        circuits=circuits,
    )

