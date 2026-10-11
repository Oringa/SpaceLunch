# CENTRIFUGE physics reference

This document describes the reduced-order aerospace model that drives every number, readout, outcome and failure in the game. Code paths are given so each statement can be checked against the implementation. All internal quantities are SI, angles are radians and temperatures are kelvin.

Every model carries one of four information classes: **physical law**, **published reference data**, **engineering approximation** or **fictional game hardware**. The class is stored next to each model and preset (`src/physics/provenance.ts`) and shown in the interface as LAW / REF / APPROX / GAME badges.

> CENTRIFUGE is inspired by kinetic-launch concepts. It is **not** a validated digital twin of SpinLaunch or any real system. Public descriptions (a proposed 100 m chamber with up to 8,000 km/h release followed by onboard propulsion; a separate 33 m suborbital system) [R1] are used only as scale references.

## 1. Architecture of the simulation

| Layer | Code | Role |
|---|---|---|
| Physics kernel | `src/physics/*` | Pure derivatives, atmosphere, forces, torques, heating, propulsion, orbit elements, integrator. No React/DOM/Three.js imports. |
| Scenario builder | `src/sim/build.ts` | Resolves a configuration + presets into physics parameters, validates it, computes derived consequences. Nothing is silently fixed. |
| Session | `src/sim/session.ts` | Launch-sequence state machine, event localisation, telemetry, extrema, commands, failures, checkpoints. |
| Workers | `src/workers/*` | Live run and cooperative prediction/batch jobs with typed, versioned messages. |

The session never reads wall-clock time: callers ask it to advance to a simulated time, and steps are never clipped at display times, so the solution is independent of frame rate and playback speed (verified in `src/tests/session.test.ts`).

## 2. Constants and frames

| Constant | Value | Class |
|---|---|---|
| g0 | 9.80665 m/s² | law (definition) |
| μ_E | 3.986004418 × 10¹⁴ m³/s² | published reference |
| R_E | 6,371,000 m (spherical approximation) | approximation |
| ω_E | 7.2921150 × 10⁻⁵ rad/s | published reference |
| σ_SB | 5.670374419 × 10⁻⁸ W/(m² K⁴) | law |

Frames (`src/physics/frames.ts`): the Earth-centred inertial frame (ECI) coincides with the Earth-fixed frame (ECEF) at t = 0; ECEF rotates about +Z at ω_E. The flight equations are integrated in ECI, so **no Coriolis or centrifugal terms** are added. Local ENU bases are computed on the sphere from geocentric latitude/longitude.

## 3. Launcher

### 3.1 Rotor kinematics and spin-up (`src/physics/rotor.ts`)

```
v_tip = ω R          rpm = 60 ω / 2π
a_radial = ω² R      a_tangential = ω̇ R
θ̇ = ω
ω̇ = (τ_motor − τ_loss) / I_total
τ_motor ≤ τ_limit,   τ_motor ω ≤ η P_electrical          (torque-limited start, defined at ω = 0)
E_rot = ½ I_total ω²,   E_vehicle = ½ m_wet v_tip²
```

`I_total` includes the hub, both tapered arms, the vehicle and cradle at R, the vehicle's own inertia about an axis parallel to the rotor axis, and the counterbalance. A speed controller saturates at the available torque and approaches the target with a first-order settle; electrical power is mechanical power divided by efficiency. The rotor state also integrates electrical, mechanical, bearing and gas-drag energy, so `E_mech − E_bearing − E_gas = E_rot` (tested to 1e-6).

Angular speed, rpm, tip speed, centripetal acceleration, release energy and spin-up time are **derived**, never independent controls.

### 3.2 Arm stress (axial-load approximation)

```
T(s) = m_tip ω² R + ∫_s^R λ(x) ω² x dx,    σ(s) = T(s) / A(s)
σ_max = ω² · max_s [G(s) / A(s)]
```

Profiles: linear, exponential and constant-stress (Gaussian, `A = A_tip (A_root/A_tip)^(1−(x/R)²)`). A uniform bar fails near `v = √(2σ/ρ)` regardless of size. Exceeding `σ_ult / SF` is a **margin warning**; reaching `σ_ult` is the **modelled failure**. Bending, joints, vibration and release transients are not analysed; an envelope on tip tangential acceleration stands in for bending and only warns.

### 3.3 Counterbalance and bearing

The counter arm (length `f·R`) carries a counter mass that statically balances the rotor before release. With a fixed counterbalance, the departing vehicle leaves an unbalanced static moment `m R`, loading the bearing with `m ω² R`; exceeding the bearing's transient envelope is a failure. The fictional *ballast-release* design discards an equal moment into a catch tube.

### 3.4 Losses

```
τ_bearing = τ_c·min(1, ω/0.05) + c_v ω
ρ_gas = p M / (R* T),   λ = k T / (√2 π d² p)
τ_gas = ½ ρ_gas C_d ω² ∫ b(x) x³ dx  (+ vehicle and counter-mass terms),
C_d = bridge(Kn = λ / b) between continuum and free-molecular values
```

### 3.5 Vacuum (`src/physics/vacuum.ts`)

```
ṗ = (Q − S p) / V,   Q = q_area × internal area
p(t) = Q/S + (p0 − Q/S) e^(−S t / V),   floor = max(Q/S, p_ult)
```

Chamber volume and internal area follow from chamber radius and depth, so larger facilities do not get free vacuum. Targets below the floor are reported as infeasible.

### 3.6 Release and exit corridor (`src/physics/launcher.ts`, `src/sim/session.ts`)

The rotor turns in the vertical plane containing the launch azimuth. With `h` the horizontal launch direction, `u` up and `a = u × h` the rotor axis:

```
r_rel(φ) = R (cos φ h − sin φ u),   v_rel = ω R (−sin φ h − cos φ u)
φ_release = 3π/2 − elevation        (the exit port location)
v_release (ECI) = ω_E × r_release + v_rel expressed in ECI
direction error ≈ ω Δt
```

Release is an **event on the integrated rotor phase**, localised with the dense output, not a frame boundary. Phase-locked release compensates nominal actuator latency; the systematic offset plus seeded jitter remain. No outward impulse is added after detachment and the rotor's angular speed is continuous (its inertia drops by the departing vehicle).

Attitude at separation: nose along the tangent, `z_b` radially outward, `y_b` along the rotor axis. A **rigid cradle passes the full rotor rate** (the vehicle keeps pitching at ω); the fictional despin cradle leaves 1 % plus a seeded error. Inherited spin is never erased silently.

Exit clearance is a swept-capsule check against the actual free space: the union of the chamber interior (disc of radius R_c and depth w_c) and the tunnel interior (radius r_ap up to the tunnel exit, with a lead-in where the axis meets the curved wall at a grazing angle). The capsule is sampled at its ends, quarter points and the exact tunnel-plane crossings (distance from the tunnel axis is convex along a segment). Steps are capped at 50 µs in the corridor, six interior samples per step feed the event detector, and the minimum clearance is refined by golden-section search on the dense output. A contact produces e.g. *"Exit clearance failed: predicted vehicle envelope intersects the port by 39.1 cm at t = 6.49 ms after release"* with X and Y from the run (penetration from a collision-free continuation). The exit membrane is an explicit boundary event (inelastic momentum loss); the gas-flow transient at the opening is **not** modelled.

## 4. Free flight (`src/physics/flight.ts`)

### 4.1 Translation

```
ṙ = v
v̇ = −μ r / |r|³ + (F_aero + F_thrust) / m
altitude = |r| − R_E
v_air = v − (ω_E × r + wind)
```

### 4.2 Atmosphere (`src/physics/atmosphere.ts`) [R6]

0–86 km: the seven USSA76 geopotential layers (H = r0 Z / (r0 + Z), r0 = 6,356,766 m) with tabulated base temperatures, lapse rates and pressures. 86–1000 km: kinetic temperature from the USSA76 analytic segments; pressure and density log-linearly interpolated from Table I. Above 1000 km: exponential extrapolation. Air never switches off at 100 km. Speed of sound uses `a = √(γ p / ρ)` with γ = 1.4 (approximate above 86 km). Optional weather: a seeded temperature-offset profile integrated hydrostatically (so p, T, ρ stay consistent) and a wind table with seeded altitude-periodic structure; both are deterministic functions of altitude, never sampled per step.

### 4.3 Aerodynamics (`src/physics/aero.ts`) [R7, J77]

```
q = ½ ρ |v_air|²
C_A(M, α) = C_A0(M) cos α |cos α|           (base-first value when flying backwards)
C_N(M, α) = (C_Nα/2) sin 2α cos(α/2) + η C_dc(M sin α) (A_p/A_ref) sin² α + fins
F_body = −q A_ref [C_A, C_N t̂_⊥]
M_cg = (x_cg − x_cp) x̂ × F_N + damping,   C_mq = −2 Σ C_Nα,i ((x_i − x_cg)/L)²
β = m / (C_D A_ref)
```

Coefficients use the base area as reference throughout. Shape families (slender ogive, blunted cone, hemisphere-cylinder, exposed stack) are **engineering approximations**, not vehicle data. Fins use thin-airfoil slopes (Ackeret above Mach 1.2) with a stalled flat-plate term, so their force vanishes with dynamic pressure. A Knudsen bridge blends toward free-molecular values (C = 2.2 on projected area). The net aerodynamic force is constrained never to do positive work relative to the air (tested over 3,000 random attitudes). Flags are raised for high α, rarefied flow and out-of-domain fineness. No Reynolds-number correction.

### 4.4 Attitude (Engineering mode)

```
q̇ = ½ q ⊗ [0, ω_b]          (q maps body → ECI, Hamilton, [w, x, y, z])
I ω̇_b = M − ω_b × (I ω_b),  I = diag(I_xx, I_yy, I_yy)
```

Inertia and CG are recomputed from components as propellant drains (settled-propellant cylinder; quasi-static, jet damping neglected). The quaternion is renormalised after each accepted step. The autopilot is a torque-limited rate-command loop; thrust-vector control is limited by `F l sin δ_max`, reaction control by its torque and finite propellant. Torque-free motion conserves inertial angular momentum to < 1e-8 over 200 s (tested), and the axis convention is tested explicitly.

**Assisted mode** prescribes attitude (nose on the air-relative velocity when unpowered, on the commanded thrust direction during burns). It has no moments and no turn-rate limits. The idealisation is labelled, and its records are kept separate.

### 4.5 Heating and thermal network (`src/physics/thermal.ts`) [R8]

```
q_s = k √(ρ / r_n) |v_air|³,   k = 1.7415 × 10⁻⁴ (SI, Earth)
hot-wall factor (T_r − T_w)/(T_r − 300 K),   T_r = T∞ + V²/(2 c_p)
free-molecular bound q ≤ ½ ρ V³
```

Four lumped nodes: stagnation surface layer and backing (per unit area, peak local flux), body skin (area-averaged fraction of stagnation flux) and the interior/payload bay (lumped). Surfaces re-radiate `ε σ (T⁴ − T_sink⁴)`; insulation conductance couples outer nodes to the interior. Flags mark speeds below the hypersonic correlation domain and rarefied flow. Presets are non-ablating; exceeding a material's envelope is reported as *"the selected thermal envelope was exceeded"*.

### 4.6 Propulsion and staging (`src/physics/propulsion.ts`) [R10]

```
ṁ = −F / (Isp g0),   F = ṁ g0 Isp(p),   Isp(p) linear between sea-level and vacuum
Δv_ideal = Isp g0 ln(m0 / mf)       (budget and test only; never an instantaneous bonus)
```

Propellant depletion is an event, so propellant never goes negative. Staging drops the empty stage, forces aeroshell jettison if still attached, and updates mass, CG, inertia and aerodynamic reference; the next stage ignites after a coast, within its ignition count.

### 4.7 Assisted insertion guidance (`src/physics/guidance.ts`)

The law chooses only a thrust **direction**. The pitch above the local horizontal is solved so the osculating apoapsis approaches the target at a commanded rate:

```
dh_apo/dt (desired) = (h_target − h_apo) / τ,   dh_apo/dt = ∇_v h_apo · a_thrust(γ)
```

It takes the root nearest the horizon, then the engine cuts off by event when the osculating periapsis reaches the cutoff altitude. It obeys thrust, gimbal, RCS and propellant limits, and fails honestly (propellant exhausted, with periapsis vs requirement) when propulsion is insufficient.

### 4.8 Orbit (`src/physics/orbit.ts`) [R9]

```
ε = |v|²/2 − μ/|r|;   h = r × v;   e = (v × h)/μ − r/|r|
p = |h|²/μ;   r_p = p/(1 + e);   r_a = 2a − r_p (bound)
```

Radial, nearly circular, parabolic and hyperbolic cases return finite or infinite values but never NaN. Orbit success requires a surviving payload on a bound trajectory with periapsis and apoapsis inside the mission band, **validated by forward propagation with drag** (one revolution by default). Crossing 100 km is a separate achievement and never implies orbit; a single ground impulse cannot produce an orbit, which the vacuum thought experiment shows.

## 5. Numerics (`src/physics/integrator.ts`)

Dormand–Prince 5(4) with FSAL, PI step control, per-component absolute tolerances (position 1 mm, velocity 1 µm/s, attitude 1e-9, thermal 1 mK) and rtol = 1e-9, with 4th-order dense output. Events are located by Illinois regula falsi on the dense output and split steps at discontinuities (release, exit, membrane, jettison, ignition, cutoff, staging, depletion, thresholds, apogee, ground contact, envelope limits).

Phase-specific step caps were set by convergence testing (`src/tests/convergence.test.ts`):

| Phase | Default cap |
|---|---|
| Rotor spin-up / hold | 0.5 s |
| Exit corridor | 50 µs |
| Atmosphere < 90 km (×10 to 140 km) | 10 ms |
| Burns | 0.25 s |
| Quiet coast | 20 s |

Uncertainty and weather are sampled once per run from named seeded streams, never per step. Fast-forward integrates every intervening step; slow motion changes presentation only.

## 6. Failure criteria

Named, never random: component load envelope (peak, and load-duration during spin-up), modelled structural limit (arm stress), bearing transient envelope, exit collision (port or chamber wall), aerodynamic overload (dynamic pressure or normal force), thermal envelope (nose, body, payload bay), unstable flight (angle of attack above the envelope while dynamic pressure is above its threshold), propellant exhausted before target, ground contact before the objective, and drive stall (the drive cannot reach the target speed: spin-up levels off where drive power balances bearing and residual-gas losses; the run is aborted at 98.5 % of that equilibrium speed). The run stops at the first failed criterion and the autopsy reports value vs threshold, time and contributing conditions.

## 7. Validation

See [docs/VALIDATION.md](docs/VALIDATION.md) (regenerated by `npm run validate`) for achieved errors, and `npm test` for the asserted thresholds.
