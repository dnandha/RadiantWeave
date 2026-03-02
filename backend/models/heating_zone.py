from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field

from .floorplan import Polygon


class HeatingZone(BaseModel):
    """Thermal design properties and geometry for a heated floor zone."""

    id: str
    name: str
    storey_id: str
    room_ids: List[str] = Field(
        default_factory=list,
        description="Rooms this zone belongs to (for reporting only).",
    )

    geometry: Polygon = Field(
        ...,
        description="Polygon describing the heated area; excludes unheated strips.",
    )

    design_indoor_temp_c: float = Field(
        20.0, description="Design indoor air temperature in °C."
    )
    design_outdoor_temp_c: float = Field(
        -10.0, description="Design outdoor temperature in °C for ΔT sizing."
    )

    floor_covering_resistance_m2k_per_w: float = Field(
        0.05,
        description="Thermal resistance of floor covering (m²K/W).",
    )
    max_floor_surface_temp_c: float = Field(
        29.0,
        description="Maximum allowable floor surface temperature in °C.",
    )

    design_heat_load_w: Optional[float] = Field(
        default=None,
        description=(
            "Optional design heat load for the zone in Watts. "
            "If omitted, a simple envelope‑based estimate can be used."
        ),
    )

