from __future__ import annotations

from typing import Iterable, List

from shapely import affinity
from shapely.geometry import LineString, Polygon as ShapelyPolygon

from ..models.floorplan import Point, Polyline, Polygon


def polygon_to_shapely(poly: Polygon) -> ShapelyPolygon:
    coords = [(p.x, p.y) for p in poly.boundary.points]
    return ShapelyPolygon(coords)


def polyline_to_linestring(line: Polyline) -> LineString:
    coords = [(p.x, p.y) for p in line.points]
    return LineString(coords)


def shapely_to_polyline(line: LineString) -> Polyline:
    pts = [Point(x=float(x), y=float(y)) for x, y in line.coords]
    return Polyline(points=pts)


def shapely_to_polygon(poly: ShapelyPolygon) -> Polygon:
    exterior = poly.exterior
    pts = [Point(x=float(x), y=float(y)) for x, y in exterior.coords]
    return Polygon(boundary=Polyline(points=pts))


def inset_polygon(poly: Polygon, inset_m: float) -> Polygon:
    """
    Inset a polygon by a given distance, roughly modelling clearance to walls.

    Positive inset shrinks the polygon; negative grows it.
    """
    s_poly = polygon_to_shapely(poly)
    inset = s_poly.buffer(-inset_m)
    if inset.is_empty:
        return poly
    # If multiple parts, take largest.
    if inset.geom_type == "MultiPolygon":
        inset = max(inset.geoms, key=lambda g: g.area)
    return shapely_to_polygon(inset)


def subtract_obstacles(zone_poly: Polygon, obstacles: Iterable[Polygon]) -> List[Polygon]:
    """Subtract obstacle polygons from a zone polygon."""
    base = polygon_to_shapely(zone_poly)
    for obs in obstacles:
        base = base.difference(polygon_to_shapely(obs))
        if base.is_empty:
            return []
    if base.geom_type == "Polygon":
        return [shapely_to_polygon(base)]
    return [shapely_to_polygon(g) for g in base.geoms if g.area > 0]


def generate_parallel_lines(
    bbox: ShapelyPolygon,
    spacing_m: float,
    angle_deg: float = 0.0,
) -> List[LineString]:
    """
    Generate parallel lines at a given spacing that cover the bounding box.

    Lines are initially axis-aligned and then rotated by angle_deg.
    """
    minx, miny, maxx, maxy = bbox.bounds
    height = maxy - miny

    lines: List[LineString] = []
    y = miny - height  # start a bit before
    while y <= maxy + height:
        line = LineString([(minx - height, y), (maxx + height, y)])
        lines.append(line)
        y += spacing_m

    if angle_deg != 0.0:
        lines = [
            affinity.rotate(line, angle_deg, origin=bbox.centroid)
            for line in lines
        ]
    return lines

