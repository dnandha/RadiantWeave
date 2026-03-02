from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field

from .floorplan import Polyline


class PipeMaterial(str, Enum):
    PEX = "pex"
    PE_RT = "pe_rt"


class Circuit(BaseModel):
    """Hydronic circuit for underfloor heating."""

    id: str
    name: str
    storey_id: str
    manifold_id: str
    zone_id: str

    subzone_index: Optional[int] = Field(
        default=None,
        description="0-based index of the subzone within the zone when zone is split into multiple circuits.",
    )

    pipe_outer_diameter_mm: float = 16.0
    pipe_material: PipeMaterial = PipeMaterial.PEX
    spacing_m: float = Field(
        0.15,
        description="Nominal center‑to‑center spacing between adjacent pipe runs.",
    )

    route: Polyline = Field(
        ...,
        description="Polyline path representing the circuit route in floor coordinates.",
    )

    return_segment_indices: List[int] = Field(
        default_factory=list,
        description=(
            "Indices of segments (between route.points[i] and route.points[i+1]) "
            "that represent return legs and should be rendered differently "
            "(e.g. dotted)."
        ),
    )

    total_length_m: float = Field(
        ...,
        description="Total developed length of pipe in this circuit (m).",
    )

    design_flow_l_per_min: Optional[float] = Field(
        default=None,
        description="Design water flow rate in L/min for this circuit.",
    )

