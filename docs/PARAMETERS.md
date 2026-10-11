# Parameter dictionary

Generated from `src/data/registry.ts` by `npm run docs:params`. Internal values are SI; the display unit is what the interface shows.
Every parameter is a build-time cause (locked during a run). Derived consequences are listed separately and are never editable.

## Launcher

| Parameter | Symbol | Path | SI unit | Display | Range | Tier | Class | Description |
|---|---|---|---|---|---|---|---|---|
| Effective arm radius | R | `launcher.armRadiusM` | m | m | 10 – 150 | primary | Fictional game hardware | Distance from the hub axis to the vehicle centre of mass (not the chamber radius or diameter). Sets omega = v/R and a = v²/R. Constrained by: `launcher.chamberRadiusM`. |
| Target tip speed | v_tip | `launcher.targetTipSpeedMps` | m/s | m/s | 200 – 4000 | primary | Physical law | Commanded release speed. Whether it is reachable depends on drive power, torque, losses and structural limits; infeasible commands are reported, not fixed. |
| Chamber inner radius | R_c | `launcher.chamberRadiusM` | m | m | 8 – 160 | detail | Fictional game hardware | Inner radius of the vacuum vessel. Must clear the vehicle on the arm. Sets chamber volume (pump-down) and the free path to the exit wall. Constrained by: `launcher.armRadiusM`, `vehicle.lengthM`. |
| Chamber axial depth | w_c | `launcher.chamberDepthM` | m | m | 1 – 20 | detail | Fictional game hardware | Depth of the disc-shaped chamber along the rotor axis. |
| Chamber pressure | p_c | `launcher.vacuum.targetPressurePa` | Pa | Pa | 0.01 – 1000 (log) | detail | Engineering approximation | Absolute pressure at launch. Lower pressure cuts residual-gas drag on the arm but lengthens pump-down. |
| Pumping speed | S | `launcher.vacuum.pumpSpeedM3s` | m³/s | m³/s | 1 – 2000 (log) | detail | Engineering approximation | Constant effective pumping speed (an idealisation: real pumps lose speed at low pressure). |
| Leak + outgassing per area | q | `launcher.vacuum.gasLoadPerAreaPaM3sM2` | Pa·m³/(s·m²) | Pa·m³/(s·m²) | 1e-7 – 0.1 (log) | expert | Engineering approximation | Gas load per unit internal surface. Larger chambers leak more: no free vacuum for big facilities. |
| Ultimate pressure floor | p_ult | `launcher.vacuum.ultimatePressurePa` | Pa | Pa | 0.00001 – 10 (log) | expert | Engineering approximation | Lowest pressure the pump set can reach regardless of time. |
| Pump electrical power | P_pump | `launcher.vacuum.pumpPowerW` | W | kW | 1000 – 5000000 | expert | Fictional game hardware | Pumps run during pump-down, spin-up and hold. |
| Chamber gas temperature | T_c | `launcher.vacuum.chamberTemperatureK` | K | K | 200 – 400 | expert | Engineering approximation | Residual gas temperature (isothermal assumption). |
| Arm material | — | `launcher.arm.materialId` | - | — | `cfrp-ud`, `maraging-steel`, `al-7075`, `fiction-cnt` | detail | Engineering approximation | Density and modelled failure threshold. Specific strength limits tip speed: a uniform bar fails at v = sqrt(2 sigma / rho). |
| Arm taper profile | — | `launcher.arm.profile` | - | — | `constant-stress`, `exponential`, `linear` | detail | Physical law | How the section area varies from root to tip. |
| Arm root section area | A_root | `launcher.arm.rootAreaM2` | m² | m² | 0.001 – 10 (log) | detail | Fictional game hardware | Cross-section at the hub, carrying the full centripetal load of the arm and tip mass. |
| Arm tip section area | A_tip | `launcher.arm.tipAreaM2` | m² | m² | 0.0005 – 2 (log) | detail | Fictional game hardware | Cross-section at the vehicle end, carrying the tip mass load m omega² R. |
| Arm section streamlining (chord/height) | c/b | `launcher.arm.sectionAspect` | - | — | 1 – 12 | expert | Engineering approximation | Higher values make a thinner frontal height for the same area, reducing residual-gas drag. |
| Hub inertia | I_hub | `launcher.hubInertiaKgM2` | kg·m² | kg·m² | 0 – 10000000 | expert | Fictional game hardware | Rotational inertia of hub and shaft. |
| Counterbalance design | — | `launcher.balanceId` | - | — | `fixed-static`, `ballast-release` | detail | Fictional game hardware | Fixed static balance leaves an imbalance m·omega²·R on the bearing after release; the fictional ballast release keeps the rotor balanced at a refurbishment cost. |
| Counterbalance radius / R | R_cb/R | `launcher.counterRadiusFraction` | - | % | 0.3 – 1 | expert | Physical law | A shorter counter arm needs a heavier counter mass (same static moment) but stores less energy. |
| Drive | — | `launcher.motorId` | - | — | `drive-1mw`, `drive-2mw`, `drive-8mw`, `drive-25mw`, `drive-50mw` | detail | Fictional game hardware | Electrical power, mechanical torque ceiling and efficiency. Torque-limited from standstill, then power-limited. |
| Bearings | — | `launcher.bearingId` | - | — | `hydrodynamic-small`, `hydrodynamic-large`, `magnetic-active` | detail | Fictional game hardware | Coulomb + viscous loss model and a transient radial-load envelope. |
| Arm drag coefficient (continuum) | C_d,c | `launcher.gasDrag.cdContinuum` | - | — | 0.05 – 3 | expert | Engineering approximation | Frontal drag coefficient of the arm section in continuum flow. |
| Arm drag coefficient (free molecular) | C_d,fm | `launcher.gasDrag.cdFreeMolecular` | - | — | 1 – 4 | expert | Engineering approximation | Frontal drag coefficient in free-molecular flow (diffuse reflection). |
| Vehicle mount | — | `launcher.mountId` | - | — | `rigid`, `despin` | detail | Fictional game hardware | Defines attitude and residual angular velocity at separation. A rigid cradle passes the full rotor rate to the vehicle. |
| Exit aperture radius | r_ap | `launcher.exit.apertureRadiusM` | m | cm | 0.05 – 2 | detail | Fictional game hardware | Radius of the exit port and tunnel. Bigger is more forgiving but needs a larger membrane and leaks more air on rupture. Constrained by: `vehicle.diameterM`, `vehicle.finsId`. |
| Exit tunnel length | L_t | `launcher.exit.tunnelLengthM` | m | m | 0 – 60 | detail | Fictional game hardware | Straight tunnel from the chamber wall to the membrane. Longer tunnels amplify timing errors (lateral offset ≈ ω·Δt·distance). |
| Exit membrane areal density | σ_m | `launcher.exit.membraneArealDensityKgM2` | kg/m² | kg/m² | 0 – 5 | expert | Engineering approximation | Membrane mass per area; the vehicle loses momentum tearing through it (perfectly inelastic approximation). |
| Release mode | — | `launcher.release.mode` | - | — | `phase-locked`, `manual-training` | detail | Fictional game hardware | Phase-locked release is the default. Manual release is a training challenge with the physical clock unchanged. |
| Release actuator latency | t_lat | `launcher.release.actuatorLatencyS` | s | ms | 0 – 0.05 | expert | Fictional game hardware | Delay between command and separation. Phase-locked release compensates its nominal value; manual release does not. |
| Systematic timing offset | Δt_0 | `launcher.release.timingOffsetS` | s | µs | -0.005 – 0.005 | detail | Fictional game hardware | Uncompensated timing bias. Direction error ≈ omega·Δt. |
| Timing jitter (1σ) | σ_t | `launcher.release.timingJitterStdS` | s | µs | 0 – 0.002 | detail | Fictional game hardware | Random timing error, sampled once per run from the seed. |
| Required safety factor | SF | `launcher.structure.safetyFactor` | - | — | 1 – 4 | detail | Engineering approximation | Warning margin on modelled arm stress. Exceeding it is a margin warning, not proof of fracture; the failure threshold is the material strength. |
| Unmodelled-bending envelope | a_t,max | `launcher.structure.maxTipTangentialAccel` | m/s | m/s | 1 – 1000 | expert | Fictional game hardware | Envelope on tip tangential acceleration (m/s²) standing in for bending, which is not simulated. |
| Regenerative braking efficiency | η_regen | `launcher.regenEfficiency` | - | % | 0 – 0.95 | expert | Fictional game hardware | Fraction of residual rotor energy recovered after release (reported separately; not credited against cost). |

## Flight

| Parameter | Symbol | Path | SI unit | Display | Range | Tier | Class | Description |
|---|---|---|---|---|---|---|---|---|
| Launch elevation | e | `flightPlan.elevationDeg` | deg | ° | 5 – 90 | primary | Physical law | Elevation of the exit tunnel. Changing it moves the exit port around the chamber: the release phase is 270° − e. |
| Flight program | — | `flightPlan.guidance.mode` | - | — | `none`, `assisted-insertion`, `prograde`, `pitch-program` | primary | Engineering approximation | Steering for the upper stage. The assisted law obeys the same thrust, torque and propellant limits and reports infeasible targets. |
| Launch azimuth | Az | `flightPlan.azimuthDeg` | deg | ° | 0 – 360 | detail | Physical law | Clockwise from north. Due east gains the most from Earth rotation; it also sets the orbital inclination. |
| Site latitude | φ | `site.latitudeDeg` | deg | ° | -89 – 89 | detail | Physical law | Geocentric latitude on the spherical Earth. |
| Site longitude | λ | `site.longitudeDeg` | deg | ° | -180 – 180 | expert | Physical law | Longitude. |
| Site altitude | h_0 | `site.altitudeM` | m | m | -400 – 5000 | detail | Physical law | Uniform terrain elevation (detailed terrain is out of scope). Higher sites start in thinner air. |
| Coast attitude control | — | `flightPlan.coastAttitude` | - | — | `passive`, `hold-air-relative` | detail | Engineering approximation | Attitude control before ignition; RCS authority and propellant are finite. |
| Target apoapsis altitude | h_t | `flightPlan.guidance.targetAltitudeM` | m | km | 120000 – 2000000 | detail | Engineering approximation | Assisted insertion holds the osculating apoapsis here while raising periapsis. |
| Cutoff periapsis altitude | h_p,cut | `flightPlan.guidance.cutoffPeriapsisM` | m | km | 50000 – 1500000 | detail | Engineering approximation | Engine cut-off once the osculating periapsis reaches this altitude. Constrained by: `flightPlan.guidance.targetAltitudeM`. |
| Staging coast | t_sep | `flightPlan.guidance.stagingCoastS` | s | s | 0 – 60 | expert | Fictional game hardware | Delay between separation and the next ignition. |

## Vehicle

| Parameter | Symbol | Path | SI unit | Display | Range | Tier | Class | Description |
|---|---|---|---|---|---|---|---|---|
| Delivered payload mass | m_pl | `vehicle.payloadMassKg` | kg | kg | 0.5 – 500 | primary | Fictional game hardware | Mass that must arrive. Distinct from the wet mass the centrifuge must accelerate. |
| Vehicle shape family | — | `vehicle.aeroFamilyId` | - | — | `slender-ogive`, `blunted-cone`, `hemisphere-cylinder` | primary | Engineering approximation | Documented coefficient-table family (Mach and angle of attack). Not an "aerodynamics quality" score: each family has a different drag, centre of pressure and heating distribution. |
| Thermal protection | — | `vehicle.protectionId` | - | — | `none`, `ti-light`, `cc-standard`, `uhtc-heavy` | primary | Fictional game hardware | Nose-cap material and thickness, body tiles and insulation. Heavier protection buys temperature margin with mass. |
| Upper stage | — | `vehicle.stackId` | - | — | `none`, `kick-solid`, `l1`, `l1-l2`, `l1lt-l2` | primary | Fictional game hardware | Onboard propulsion carried inside the aeroshell. Needs volume: tanks must fit, and must survive the centrifuge load. |
| Payload hardware class | — | `vehicle.payloadId` | - | — | `instrument-hardened`, `smallsat-hardened`, `commercial-avionics` | detail | Fictional game hardware | Load-duration and temperature envelope of the payload. |
| Vehicle length | L | `vehicle.lengthM` | m | m | 0.5 – 12 | detail | Fictional game hardware | Sets internal volume, wetted area, inertia and chamber clearance. |
| Vehicle diameter | D | `vehicle.diameterM` | m | cm | 0.05 – 1.5 | detail | Fictional game hardware | Sets the drag reference area A = pi D²/4 and internal volume. |
| Effective nose radius | r_n | `vehicle.noseRadiusM` | m | cm | 0.003 – 0.75 | detail | Engineering approximation | Larger radius lowers stagnation heating (q ∝ 1/sqrt(r_n)) but adds drag; constrained by the shape family. Constrained by: `vehicle.diameterM`, `vehicle.aeroFamilyId`. |
| Fins | — | `vehicle.finsId` | - | — | `none`, `small-tail`, `large-tail` | detail | Fictional game hardware | Tail fins move the centre of pressure aft (stability) and add mass and drag. Their force vanishes with dynamic pressure. |
| Airframe areal mass | m″_af | `vehicle.airframeArealMassKgM2` | kg/m² | kg/m² | 2 – 60 | expert | Fictional game hardware | Structural mass per wetted area of the aeroshell. |
| Nose fairing mass | m_f | `vehicle.fairingMassKg` | kg | kg | 0 – 200 | expert | Fictional game hardware | Jettisoned with the aeroshell. |
| Mounting/interface hardware | m_mt | `vehicle.mountingMassKg` | kg | kg | 0 – 200 | expert | Fictional game hardware | Interface hardware that flies with the vehicle and is discarded with the aeroshell. |
| Nose ballast | m_b | `vehicle.noseBallastKg` | kg | kg | 0 – 300 | detail | Fictional game hardware | Moves the CG forward for stability at the cost of mass. |
| Reaction control | — | `vehicle.rcsId` | - | — | `none`, `cold-gas`, `hydrazine` | detail | Fictional game hardware | Finite-torque, finite-propellant attitude control for thin air and vacuum. |
| Aeroshell dynamic-pressure envelope | q_max | `vehicle.maxDynamicPressurePa` | Pa | MPa | 10000 – 20000000 | detail | Fictional game hardware | Exceeding it is an aerodynamic-overload failure. |
| Aeroshell normal-force envelope | N_max | `vehicle.maxNormalForceN` | N | kN | 100 – 5000000 | detail | Fictional game hardware | Bending proxy: aerodynamic normal-force limit. |
| Angle-of-attack envelope | α_max | `vehicle.maxAngleOfAttackDeg` | deg | ° | 1 – 90 | expert | Fictional game hardware | Unstable-flight criterion: exceeded while dynamic pressure is above the threshold below. |
| AoA envelope applies above q | q_α | `vehicle.angleLimitAboveQPa` | Pa | kPa | 100 – 5000000 | expert | Fictional game hardware | Dynamic pressure above which the angle-of-attack envelope applies. |

## Environment

| Parameter | Symbol | Path | SI unit | Display | Range | Tier | Class | Description |
|---|---|---|---|---|---|---|---|---|
| Wind | — | `environment.wind.enabled` | - | — | on/off | detail | Engineering approximation | Horizontal wind vs altitude (table + seeded structure). |
| Atmosphere perturbation | — | `environment.perturbation.enabled` | - | — | on/off | detail | Engineering approximation | Seeded, hydrostatically consistent pressure/temperature perturbation of USSA76. |
| Weather seed | — | `environment.weatherSeed` | - | — | 0 – 1000000000 | detail | Fictional game hardware | Reproduces the same environment independently of solver step size. |

## Mode

| Parameter | Symbol | Path | SI unit | Display | Range | Tier | Class | Description |
|---|---|---|---|---|---|---|---|---|
| Flight-dynamics fidelity | — | `fidelity` | - | — | `engineering`, `assisted` | detail | Physical law | Engineering integrates attitude with Euler's rigid-body equation and finite control authority. Assisted prescribes orientation (zero angle of attack, instant thrust pointing): an idealisation that is labelled and kept in separate records. |
| Run seed | — | `seed` | - | — | 0 – 1000000000 | detail | Fictional game hardware | Seeds release jitter, mount error and (if enabled) hardware uncertainty. |
| Atmosphere and aerodynamic heating | — | `physics.atmosphere` | - | — | on/off | detail | Physical law | Disable for the vacuum thought experiment (gravity and orbital mechanics stay). Records are kept separate. |
| Earth rotation | — | `physics.earthRotation` | - | — | on/off | expert | Physical law | Disable to isolate rotation effects. Records are kept separate. |
| Hardware/model uncertainty | — | `uncertainty.enabled` | - | — | on/off | detail | Engineering approximation | Perturbs aerodynamic, thermal, strength, drive and Isp parameters from their provenance uncertainty, using the run seed. |

## Numerics

| Parameter | Symbol | Path | SI unit | Display | Range | Tier | Class | Description |
|---|---|---|---|---|---|---|---|---|
| Relative tolerance | rtol | `integrator.rtol` | - | — | 1e-12 – 0.00001 (log) | expert | Engineering approximation | Dormand-Prince error control. Settings are justified by convergence tests. |
| Position tolerance | atol_r | `integrator.positionTolM` | m | mm | 0.000001 – 1 (log) | expert | Engineering approximation | Absolute position tolerance; velocity uses 1e-3 of it. |
| Step cap: exit corridor | h_cor | `integrator.hMaxCorridorS` | s | µs | 0.000001 – 0.001 | expert | Engineering approximation | Maximum step inside chamber and tunnel. |
| Step cap: atmospheric flight | h_atm | `integrator.hMaxAtmosphereS` | s | ms | 0.0001 – 1 | expert | Engineering approximation | Maximum step below 90 km (x10 between 90 and 140 km). |
| Step cap: burns | h_burn | `integrator.hMaxBurnS` | s | s | 0.001 – 5 | expert | Engineering approximation | Maximum step while an engine burns. |
| Step cap: coast | h_coast | `integrator.hMaxCoastS` | s | s | 0.01 – 120 | expert | Engineering approximation | Maximum step in quiet exo-atmospheric coast. |
| Step cap: rotor spin-up | h_rot | `integrator.hMaxRotorS` | s | s | 0.001 – 5 | expert | Engineering approximation | Maximum step during spin-up and hold. |

## Derived consequences (not editable)

| Quantity | Symbol | Unit | Model | Formula | Class |
|---|---|---|---|---|---|
| Angular speed | ω | rad/s | rotor | ω = v_tip / R | Physical law |
| Rotor speed | n | rpm | rotor | n = 60 ω / 2π | Physical law |
| Centripetal load | a/g0 | g | rotor | a = ω² R; worst felt lateral load = (ω² R + g0)/g0 | Physical law |
| Vehicle translational energy at release | E_v | MJ | rotor | E_v = ½ m_wet v_tip²  (not the electricity bill) | Physical law |
| Rotating-assembly energy | E_rot | MJ | rotor | E_rot = ½ I_total ω² | Physical law |
| Peak arm axial stress | σ_max | GPa | rotor | σ(s) = [m_tip ω² R + ∫_s^R λ ω² x dx] / A(s) | Engineering approximation |
| Spin-up time | t_spin | s | rotor | ω̇ = (τ_m − τ_loss)/I, τ_m ≤ τ_lim, τ_m ω ≤ η P_e | Physical law |
| Highest sustainable tip speed | v_eq | m/s | rotor | τ_avail(ω) = τ_bearing(ω) + τ_gas(ω) | Engineering approximation |
| Residual-gas drag power at target | P_gas | MW | rotor | P = k_gas ω³, k_gas = ½ ρ_c C_d ∫ b x³ dx + vehicle + counter mass | Engineering approximation |
| Pump-down time | t_pump | s | vacuum | t = (V/S) ln[(p0 − Q/S)/(p_t − Q/S)] | Engineering approximation |
| Post-release bearing load | F_b | MN | rotor | F = m_wet ω² R (fixed balance) | Physical law |
| Wet mass | m_wet | kg | vehicle | Σ components (payload, stages, propellant, aeroshell, TPS, fins, RCS) | Physical law |
| Ballistic coefficient (M=6) | β | kg/m² | aero | β = m / (C_D A_ref) | Engineering approximation |
| Static margin | SM | cal | aero | SM = (x_cp − x_cg)/D | Engineering approximation |
| Ideal Δv | Δv | m/s | propulsion | Σ Isp g0 ln(m0/mf) per stage | Physical law |
| Release timing tolerance (estimate) | Δt_tol | µs | launcher | Δt ≈ (r_ap − r_env) / (ω · s_end) | Physical law |
| Direction error per ms | δ | rad | launcher | δ ≈ ω Δt | Physical law |
| Inclination estimate | i | ° | orbit | cos i = cos φ sin Az | Physical law |
