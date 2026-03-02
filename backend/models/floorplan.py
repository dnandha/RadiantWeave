from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class StoreyId(str):
    """Type alias for storey identifiers."""


class Point(BaseModel):
    """2D point in floor coordinates (meters)."""

    x: float
    y: float


class Polyline(BaseModel):
    """Ordered list of points representing a line or polygon boundary."""

    points: List[Point] = Field(default_factory=list)

    @property
    def is_closed(self) -> bool:
        return bool(self.points) and self.points[0] == self.points[-1]


class Polygon(BaseModel):
    """Polygon stored as a closed polyline; first and last point should coincide."""

    boundary: Polyline


class StoreyType(str, Enum):
    GROUND = "ground"
    UPPER = "upper"


class Room(BaseModel):
    """Geometric room representation for one storey."""

    id: str
    name: str
    storey_id: str
    outline: Polygon
    obstacles: List[Polygon] = Field(
        default_factory=list,
        description="Areas where pipes are not allowed (shafts, fixtures, etc.).",
    )


class Manifold(BaseModel):
    """Connection point for a set of heating circuits on a storey."""

    id: str
    storey_id: str
    position: Point
    name: Optional[str] = None


class Storey(BaseModel):
    """A building storey with associated rooms and manifolds."""

    id: str
    name: str
    level_elevation: float = Field(
        ..., description="Elevation in meters from a common reference."
    )
    type: StoreyType = StoreyType.GROUND
    rooms: List[Room] = Field(default_factory=list)
    manifolds: List[Manifold] = Field(default_factory=list)


class Floorplan(BaseModel):
    """Floorplan for a multi‑storey building."""

    id: str
    name: str
    # Either provide explicit scale or derive from reference distance.
    pixels_per_meter: float = Field(
        ...,
        description=(
            "Scale factor for converting image pixels to meters in floor coordinates."
        ),
    )
    storeys: List[Storey] = Field(default_factory=list)

