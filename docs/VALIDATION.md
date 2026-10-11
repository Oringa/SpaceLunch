# Validation results

Model `centrifuge-model-1.0.0`, generated 2026-10-11T11:05Z on Node v22.22.0 by `npm run validate`. Values below are recomputed by the production kernel; `npm test` asserts the thresholds.

## Synthetic reference case (R = 50 m, v = 2,000 m/s)

| Quantity | Computed | Expected |
|---|---|---|
| Angular speed | 40 rad/s | 40 rad/s |
| Rotor speed | 381.9719 rpm | 381.9719 rpm |
| Centripetal acceleration | 80000.0 m/s² | 80,000 m/s² |
| Centripetal g-load | 8157.73 g | 8,157.73 g |
| 200 kg translational energy | 400.000 MJ = 111.111 kWh | 400 MJ = 111.111 kWh |
| Dynamic pressure at 1.225 kg/m³ | 2.4500 MPa | 2.45 MPa |
| Direction error, 1 ms | 0.04000 rad = 2.29183° | 0.04 rad = 2.29183° |

## USSA76 spot checks

| Altitude | Density (computed) | Reference | Rel. error |
|---|---|---|---|
| 0 km | 1.22500e+0 | 1.22500e+0 | 6.9e-7 |
| 11 km | 3.64802e-1 | 3.64801e-1 | 1.5e-6 |
| 50 km | 1.02688e-3 | 1.02687e-3 | 7.8e-6 |
| 86 km | 6.95800e-6 | 6.95800e-6 | 2.4e-16 |
| 100 km | 5.60400e-7 | 5.60400e-7 | 5.7e-16 |
| 500 km | 5.21500e-13 | 5.21500e-13 | 3.9e-16 |

## Radial launch at 2,000 m/s (no air, no rotation)

Apogee 210.3861 km (analytic 210.386 km). Classified radial, Earth-intersecting: never an orbit.

## Ten-orbit gravity-only drift (200 km circular, production tolerances)

Circular speed 7788.488 m/s (expected 7,788.488). Relative energy drift 2.56e-10, angular-momentum drift 1.28e-10 (target < 1e-6), 2656 steps.

## Constant-density drag decay

Max relative speed error vs v0/(1 + k v0 t) over 30 s: 9.58e-12.

## Mission reference designs (solver runs)

| Mission | Design | Passed | Key result | Wall time |
|---|---|---|---|---|
| 1. Clean release | instrument-hop | yes | apogee 12.4 km | 1072 ms |
| 2. Thirty kilometres on a budget | thirty-km | yes | apogee 38.4 km | 1504 ms |
| 3. Edge of space | edge-of-space | yes | apogee 120.8 km | 1433 ms |
| 4. Low Earth orbit | leo-reference | yes | orbit 204.9 × 371.7 km | 917 ms |
| 5. Optimise delivered mass per credit | leo-optimised | yes | orbit 204.9 × 362.0 km | 749 ms |

## Failure reference cases

| Case | Expected | Observed | Message |
|---|---|---|---|
| Small motor, big ambition | drive-stall | drive-stall | Launch aborted: spin-up stalled at 1100 m/s of the 2600 m/s target. Near 1117 m/s, bearing friction and drag from the residual gas absorb all 1.0 MW of drive po |
| Ordinary avionics on a centrifuge | component-load | component-load | Component load envelope exceeded: Payload (Ordinary avionics (not hardened)) stayed above its sustained limit 200 g for 5 s (current load 436 g). Spin-up and ho |
| Aluminium arm at 1 km/s | structural-limit | structural-limit | Modelled structural limit exceeded: arm axial stress 0.57 GPa reached the Aluminium 7075-T6 threshold 0.57 GPa at tip speed 956 m/s, t = 11.9 min. |
| Fixed counterbalance, small bearing | bearing-envelope | bearing-envelope | Bearing transient-load envelope exceeded at release: the departing 149 kg vehicle left an unbalanced static moment of 7470 kg·m, loading the hub bearing with 13 |
| Rigid cradle | exit-collision | exit-collision | Exit clearance failed: predicted vehicle envelope intersects the port by 39.1 cm at t = 6.49 ms after release. |
| Release 0.5 ms late | exit-collision | exit-collision | Exit clearance failed: predicted vehicle envelope intersects the port by 45.1 cm at t = 7.32 ms after release. |
| Unfinned, aft-heavy orbital vehicle | aero-overload | aero-overload | Aerodynamic overload: aerodynamic normal force reached 4.00e+5 N at t = 194.92 ms after release (altitude 1.85 km). |
| Unstable vehicle with a stiff airframe | unstable-flight | unstable-flight | Unstable flight outside the allowed envelope: angle of attack 12.0° exceeded 12° while dynamic pressure was 2440 kPa (threshold 200 kPa). |
| Bare aluminium nose at 2 km/s | thermal-envelope | thermal-envelope | The selected thermal envelope was exceeded: nose surface (Bare aluminium nose (no TPS)) reached 450 K at t = 201.35 ms after release, altitude 1.9 km. |
| Too much payload for the upper stage | propellant-exhausted | propellant-exhausted | Propellant exhausted before target orbit: periapsis -447.0 km < required 205 km (apoapsis 264 km). |
| Orbital vehicle without a burn | mission:ground-contact | terminal: ground-contact |  |

## Designs

- **Instrument hop** (`instrument-hop`): 15 m arm, 1 km/s, 3 kg instrument. Fast to spin up; the easy first launch.
- **Thirty-kilometre sounder** (`thirty-km`): 25 m arm, 1.5 km/s, 10 kg payload to the stratosphere.
- **Edge-of-space hop** (`edge-of-space`): 50 m arm, 2.1 km/s, near-vertical: above 100 km but Earth-intersecting.
- **LEO reference** (`leo-reference`): 50 m arm at 2.22 km/s (8,000 km/h scale) plus a two-stage liquid upper stage.
- **LEO optimised** (`leo-optimised`): Same machine; 18 kg payload with margins kept (Mission 5 reference).

