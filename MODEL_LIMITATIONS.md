# Model limitations

CENTRIFUGE uses a reduced-order simulation. It is honest about what it does not model; this list is also shown in the in-app Help.

## Excluded from this release

- **Earth oblateness (J2)** and other long-term orbital perturbations (third bodies, solar radiation pressure). Earth is a sphere of radius 6,371 km.
- **Detailed terrain.** A uniform site elevation is used everywhere for ground contact.
- **Computational fluid dynamics** and **finite-element structural analysis.** Aerodynamics use shape-family coefficient tables; structures use axial-load stress plus envelopes.
- **Flexible-body vibration and arm bending.** Bending is represented only by a tip tangential-acceleration envelope that warns.
- **Detailed gas flow at the chamber opening.** The exit membrane is an inelastic momentum loss; the transient flow of air into the tunnel is not modelled.
- **Ablation and material microphysics.** Thermal protection presets are non-ablating; failures are envelope exceedances.
- **Solar and Earth infrared heating**, and solar-cycle thermospheric variability (the atmosphere above 86 km is the USSA76 mean profile, optionally scaled by a seeded factor).
- **Real weather.** The atmosphere is a mean profile with optional seeded, hydrostatically consistent perturbations; wind is a user table plus seeded structure.

## Approximations to keep in mind

| Area | Approximation | Consequence |
|---|---|---|
| Aerodynamic coefficients | Generic tables per shape family; no Reynolds-number correction; Jorgensen-type crossflow at large angles | ±20–30 % uncertainty in drag and normal-force slope; flags raised outside the table domain |
| Rarefied flow | Smooth Knudsen bridge to C = 2.2 free-molecular values | Orbital decay and very-high-altitude drag are approximate |
| Mach number above 86 km | γ = 1.4 everywhere | Mach is approximate where atomic oxygen dominates |
| Heating | Sutton-Graves stagnation correlation with hot-wall factor; area-averaged body fraction | Flagged below ~2 km/s / Mach 4 and in rarefied flow; temperatures are model-node values, not measured wall temperatures |
| Thermal nodes | Four lumped nodes; stagnation backing temperature drives interior conduction | Interior heating is conservative; not a 1-D conduction solution |
| Attitude | Rigid body; inertia updated quasi-statically; jet damping and slosh neglected | Burn-phase rotational dynamics are idealised |
| Autopilot | Continuous rate-command law (no sample rate, no actuator dynamics or gimbal rate limit) | Control is smoother than a real flight computer |
| Guidance | Simple in-plane apoapsis-rate steering, not an optimal ascent | Performance margins are slightly pessimistic; inclination is set only by site latitude and azimuth |
| Rotor losses | Coulomb + viscous bearings; bridged residual-gas drag; no arm heating | Loss powers are order-of-magnitude |
| Vacuum | Constant pumping speed; constant gas load per area | Real pumps slow down at low pressure |
| Despin cradle, ballast release | Fictional game hardware | Not a description of any proprietary mechanism |
| Material and hardware data | Representative handbook magnitudes and game values | Not certified design allowables |
| Costs | Fictional game credits | Not a cost estimate |

## Reproducibility

Runs are deterministic for a given configuration, seed and command stream, and replay exactly in the same build. Reproducibility across browsers is tested within numerical tolerances, not promised bit-for-bit (floating-point transcendental functions can differ in the last digits between engines).

## Scope statement

Inspired by kinetic-launch concepts; not a validated digital twin of SpinLaunch or any real system. Public scale references are used for orientation only, and are not evidence that any proposed orbital system has flown.
