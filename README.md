# CENTRIFUGE

A browser-based kinetic-launch engineering game. A centrifuge spins a payload up inside a vacuum chamber and releases it through an exit tunnel. For orbit, an onboard upper stage must then add horizontal speed.

The loop is: **configure → predict → spin up → release → survive the atmosphere → insert into orbit → diagnose → improve**.

Every significant visual, instrument reading, outcome and failure comes from a reduced-order, double-precision aerospace simulation running in Web Workers. There are no scripted trajectories. The launch button starts the same solver that produced the prediction.

> Inspired by kinetic-launch concepts; **not** a validated digital twin of SpinLaunch or any real system. See [MODEL_LIMITATIONS.md](MODEL_LIMITATIONS.md).

## Quick start

```bash
npm ci              # pinned dependencies (package-lock.json)
npm run dev         # http://localhost:5173
```

The app opens on a tested easy preset (*Instrument hop*). Press **Launch** (or `L`): pump-down and spin-up are time-compressed automatically, the release slows down so you can watch the vehicle leave through the port, and the flight plays back with the physical clock always shown.

## Build and deploy (static)

```bash
npm run build            # type-check + production build into dist/
npm run serve:subpath    # serves dist/ at http://127.0.0.1:4173/centrifuge/
```

The build uses a **relative asset base** (`base: './'`), so the same `dist/` folder works unchanged at any sub-path, for example `https://alonoring.com/centrifuge/`. Copy the contents of `dist/` into a `centrifuge/` folder on any static host. There are no accounts, no simulation server, no paid APIs and no runtime data downloads. Serve it over HTTP(S); opening `index.html` from disk is not supported (module workers need an origin). To emit absolute URLs instead, build with `BASE_PATH=/centrifuge/ npm run build`.

`.github/workflows/ci-pages.yml` type-checks, tests, builds and runs the browser tests. On `main` (or a manual dispatch) it deploys `dist/` to GitHub Pages once Pages is enabled with source "GitHub Actions".

## Tests

```bash
npm test                 # headless unit/integration suite (Vitest)
npm run validate         # recompute and publish achieved errors -> docs/VALIDATION.md
npm run test:browser     # Playwright smoke tests against the sub-path build
npm run docs:params      # regenerate docs/PARAMETERS.md from the registry
```

What is covered:

- **Section 8 reference values**: R = 50 m, v = 2,000 m/s → 40 rad/s, 381.9719 rpm, 80,000 m/s², 8,157.73 g, 400 MJ = 111.111 kWh, 2.45 MPa, 0.04 rad = 2.29183° per ms.
- **Invariants and analytic cases**: straight-line motion without gravity or air; torque-free angular momentum conservation; quaternion convention; radial 2,000 m/s launch to 210.386 km that is never classified as an orbit; 200 km circular speed 7,788.488 m/s with ten-orbit energy and angular-momentum drift below 1e-6; constant-density drag decay v0/(1 + k v0 t); vacuum mass independence; aerodynamic force never doing positive work relative to still air; the ideal rocket equation, with propellant never negative.
- **Atmosphere**: USSA76 table values, the 86 km layer joint, positivity and monotonic decrease from −5 to 3,000 km, no cut-off at 100 km, and hydrostatic consistency of perturbed weather.
- **Numerics**: integrator accuracy and dense output; event localisation; convergence of apogee, peak q, peak heat flux, release clearance (including a narrow release window) and orbital elements under tighter tolerances.
- **Session and workers**: outcome independent of how often or how far playback advances; abort, command logging and exact replay; manual-release latency; reproducible seeds; repeated resets; pump-down analytic vs numeric; spin-up energy closure; stale-result rejection; prediction cancellation; batch jobs; live playback with a fake clock.
- **Inputs**: JSON round-trip; malformed files rejected with path-level messages; degenerate geometry rejected instead of producing NaN; zero wind, zero rotation and out-of-domain coefficients run without NaN.
- **Missions and failures**: every mission has a stored reference configuration that passes in the solver, and every failure class has a deterministic failing case.

Actual results from the last run are recorded in [docs/VALIDATION.md](docs/VALIDATION.md); see also the *Verification log* below.

## Architecture

```
src/
  physics/   pure kernel: constants, frames, atmosphere, wind, aero, thermal, rotor,
             vacuum, propulsion, vehicle mass properties, launcher geometry,
             guidance, flight equations, orbit elements, DOPRI5 integrator
  sim/       configuration schema, scenario builder (validation + consequences),
             session state machine, telemetry, JSON import/export
  workers/   typed protocol, worker engine (live run, cooperative prediction/batch jobs)
  rendering/ Three.js launcher / world / orbit views, 2D fallback
  ui/        React interface: controls, instruments, plots, analysis, inspector
  game/      missions, scoring keys, fictional cost model
  data/      presets with provenance, designs, failure cases, parameter registry, sources
  tests/     analytical, numerical, mission, failure, session and worker tests
e2e/         Playwright browser tests
```

- The **physics kernel** has no React, DOM or Three.js imports.
- The **simulation worker** owns authoritative state. It is created with Vite's module-worker pattern and publishes 30 Hz snapshots and transferable `Float64Array` telemetry batches. Extrema are recorded at solver resolution.
- A second worker instance runs **predictions and experiment batches** cooperatively, so they are cancellable. Messages carry `runId`/`jobId` and `configVersion`, and stale results are rejected.
- The **renderer** reads snapshots and telemetry each animation frame. It never writes physical state. Geometry is camera-relative (origins subtracted in double precision before Float32), with separate launcher, world and orbital views of the same state.
- Neither `SharedArrayBuffer` nor cross-origin isolation is required.

## Playing

- **Build** tab: eight primary controls (radius, target speed, elevation, payload mass, shape family, protection, upper stage, flight program), with live consequences under each, plus expandable detail and expert sections. Each control shows its unit, a provenance badge (LAW / REF / APPROX / GAME) and an ⓘ inspector with the formula, sources and assumptions. The preflight list and the live prediction use the same solver.
- **Flight** tab: launcher cutaway (stroboscopic at high rpm, labelled), **World** view of the launch from afar over the curved Earth, and an **Orbit** view with the osculating trajectory, apsides and target band. Instruments show the limiting constraint. Synchronised telemetry plots share one time cursor with the 3D scene and the event log.
- **Analysis** tab: failure autopsy (criterion, value vs threshold, time, contributing conditions, preceding data), mission objectives, solver-resolution peaks, energy and cost accounting, and ghost comparison of up to three runs. Experiments include counterfactual retry, the vacuum thought experiment, a constraint frontier and a seeded robustness batch with Wilson intervals.
- **Missions**: clean release → 30 km on an energy budget → 40 kg above 100 km → validated LEO → optimise kg per credit with margins kept. Records are separated by model version, fidelity, physics toggles, uncertainty and release mode.

Keyboard: `L` launch · `Space` play/pause · `R` reset · `1`/`2`/`3` views · `B`/`F`/`A` tabs · `?` help.

## Documents

- [PHYSICS.md](PHYSICS.md): models, equations and numerics
- [MODEL_LIMITATIONS.md](MODEL_LIMITATIONS.md): exclusions and approximations
- [SOURCES.md](SOURCES.md): references and data licences
- [docs/PARAMETERS.md](docs/PARAMETERS.md): parameter dictionary (generated)
- [docs/VALIDATION.md](docs/VALIDATION.md): achieved numerical errors and reference runs (generated)

## Verification log

See the bottom of this file, updated at release time.
