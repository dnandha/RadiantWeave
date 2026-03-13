from __future__ import annotations

import math

# Defaults for max circuit length calculation (Darcy-Weisbach).
# 200 mbar = 20 kPa max pressure drop per circuit.
# The velocity is a reference value only; actual hydraulic limits depend on design flow.
DEFAULT_MAX_PRESSURE_DROP_KPA = 20.0  # 200 mbar
DEFAULT_FLOW_VELOCITY_M_S = 0.37
DEFAULT_WATER_TEMP_C = 40.0
DEFAULT_PIPE_WALL_THICKNESS_MM = 2.0
DEFAULT_PIPE_OUTER_DIAMETER_MM = 12.0


def water_density_kg_per_m3(temp_c: float) -> float:
    """Approximate water density (kg/m³) at given temperature (°C). Valid ~0–60°C."""
    # Kell correlation for liquid water.
    t = max(0.0, min(60.0, temp_c))
    return 1000.0 * (
        1.0
        - ((t + 288.9414) / (508929.2 * (t + 68.12963))) * (t - 3.9863) ** 2
    )


def water_kinematic_viscosity_m2_per_s(temp_c: float) -> float:
    """Approximate water kinematic viscosity (m²/s) at given temperature (°C). Valid ~0–60°C."""
    t = max(0.0, min(60.0, temp_c))
    t_k = t + 273.15
    # Andrade-style dynamic viscosity for water (Pa·s), then convert to kinematic viscosity.
    dynamic_viscosity_pa_s = 2.414e-5 * 10 ** (247.8 / (t_k - 140.0))
    return dynamic_viscosity_pa_s / water_density_kg_per_m3(t)


def calculate_max_circuit_length_m(
    pipe_outer_diameter_mm: float,
    pipe_wall_thickness_mm: float = DEFAULT_PIPE_WALL_THICKNESS_MM,
    max_pressure_drop_kpa: float = DEFAULT_MAX_PRESSURE_DROP_KPA,
    flow_velocity_m_s: float = DEFAULT_FLOW_VELOCITY_M_S,
    water_temp_c: float = DEFAULT_WATER_TEMP_C,
) -> float:
    """
    Reference maximum circuit length (m) from Darcy-Weisbach for a given pipe size.

    This is only a reference recommendation because diameter alone is not enough
    to determine a true hydraulic limit; actual max length depends on design flow.
    Uses a reference flow velocity plus Blasius friction factor for turbulent flow
    (Re >= 2300), with f = 64/Re for laminar flow.
    """
    d_inner_mm = pipe_outer_diameter_mm - 2.0 * pipe_wall_thickness_mm
    if d_inner_mm <= 0:
        return 0.0

    d_inner_m = d_inner_mm / 1000.0
    if flow_velocity_m_s <= 0 or max_pressure_drop_kpa <= 0:
        return 0.0

    rho = water_density_kg_per_m3(water_temp_c)
    nu = water_kinematic_viscosity_m2_per_s(water_temp_c)
    re = flow_velocity_m_s * d_inner_m / nu
    if re <= 0:
        return 0.0

    if re < 2300:
        f = 64.0 / re
    else:
        f = 0.316 / (re ** 0.25)

    dP_pa = max_pressure_drop_kpa * 1000.0
    # Darcy-Weisbach: dP = f * (L/d) * (rho * v^2 / 2) => L = 2 * dP * d / (f * rho * v^2)
    length_m = 2.0 * dP_pa * d_inner_m / (f * rho * flow_velocity_m_s ** 2)
    return max(0.0, length_m)
