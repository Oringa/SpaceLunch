/**
 * Model inspector registry: every significant readout links to one of these
 * entries, which state the governing equation, source classification,
 * references, assumptions and applicability.
 */
import type { SourceClass } from '../physics/provenance';

export interface ModelEntry {
  id: string;
  title: string;
  classification: SourceClass;
  equations: string[];
  sources: string[];
  assumptions: string[];
  applicability: string;
  code: string;
}

export const MODELS: ModelEntry[] = [
  {
    id: 'rotor', title: 'Rotor kinematics, spin-up and energy', classification: 'physical-law',
    equations: ['v_tip = ω R', 'rpm = 60 ω / 2π', 'a_radial = ω² R, a_tangential = ω̇ R', 'θ̇ = ω, ω̇ = (τ_motor − τ_loss) / I_total', 'τ_motor ≤ τ_limit, τ_motor ω ≤ η P_electrical', 'E_rot = ½ I_total ω²; E_vehicle = ½ m_wet v_tip²'],
    sources: [], assumptions: ['Rigid rotor about a fixed axis', 'Torque-limited start (defined at ω = 0), then power-limited', 'Electrical power = mechanical power / efficiency', 'Pumps keep running through spin-up'],
    applicability: 'Any speed; structural validity limited by the arm-stress approximation.', code: 'src/physics/rotor.ts',
  },
  {
    id: 'arm-stress', title: 'Arm axial stress (axial-load approximation)', classification: 'engineering-approximation',
    equations: ['T(s) = m_tip ω² R + ∫_s^R λ(x) ω² x dx', 'σ(s) = T(s) / A(s)', 'σ_max = ω² · max_s[G(s)/A(s)]', 'Uniform bar limit: v = √(2σ/ρ)'],
    sources: ['H1'], assumptions: ['Pure tension along the arm; no bending, joints, vibration or release transient', 'Safety-factor margin is a warning; failure threshold is the material strength', 'Separate envelope on tip tangential acceleration stands in for bending'],
    applicability: 'Not a rotating composite-beam analysis.', code: 'src/physics/rotor.ts',
  },
  {
    id: 'losses', title: 'Bearing and residual-gas losses', classification: 'engineering-approximation',
    equations: ['τ_bearing = τ_c + c_v ω', 'ρ_gas = p M / (R T)', 'τ_gas = ½ ρ C_d ω² ∫ b(x) x³ dx (+ vehicle, counter mass)', 'C_d bridged from continuum to free molecular in Kn = λ / b'],
    sources: [], assumptions: ['Empirical Coulomb + viscous bearing loss', 'Isothermal residual gas', 'No gas heating of the arm'], applicability: 'Order-of-magnitude loss estimate.', code: 'src/physics/rotor.ts',
  },
  {
    id: 'vacuum', title: 'Chamber pump-down', classification: 'engineering-approximation',
    equations: ['ṗ = (Q − S p) / V', 'p(t) = Q/S + (p0 − Q/S) e^(−S t / V)', 'Q = q_area × internal area'],
    sources: [], assumptions: ['Constant pumping speed', 'Isothermal', 'Gas load ∝ internal area', 'Ultimate-pressure floor'], applicability: 'Idealised; real pumps lose speed at low pressure.', code: 'src/physics/vacuum.ts',
  },
  {
    id: 'release', title: 'Release and exit corridor', classification: 'physical-law',
    equations: ['v_release = ω_E × r_release + v_rotor (inertial frame)', 'φ_release = 270° − elevation', 'direction error ≈ ω Δt', 'Clearance = r_aperture − r_envelope − max distance of the swept capsule from the tunnel axis'],
    sources: ['R9'], assumptions: ['Release at the integrated rotor phase (event-localised)', 'No outward impulse after detachment; rotor ω continuous', 'Rigid mount passes the rotor rate to the vehicle; despin mount is fictional hardware', 'Membrane modelled as an inelastic momentum loss', 'Gas-flow transient at the opening omitted'],
    applicability: 'Exit corridor geometry is exact for the modelled shapes.', code: 'src/physics/launcher.ts, src/sim/session.ts',
  },
  {
    id: 'gravity', title: 'Gravity and inertial-frame translation', classification: 'physical-law',
    equations: ['ṙ = v', 'v̇ = −μ r / |r|³ + (F_aero + F_thrust) / m', 'μ = 3.986004418e14 m³/s², R_E = 6,371 km (sphere), ω_E = 7.2921150e-5 rad/s'],
    sources: ['R9'], assumptions: ['Spherical Earth; no oblateness (J2) or third bodies', 'No Coriolis/centrifugal terms: the frame is inertial'], applicability: 'Excellent for short flights; long-term perturbations excluded.', code: 'src/physics/flight.ts',
  },
  {
    id: 'atmosphere', title: 'U.S. Standard Atmosphere 1976 + upper extension', classification: 'published-reference',
    equations: ['0–86 km: seven geopotential layers, hydrostatic', '86–1000 km: USSA76 Table I pressure/density (log-linear), analytic temperature', '> 1000 km: exponential extrapolation', 'v_air = v − (ω_E × r + wind)'],
    sources: ['R6'], assumptions: ['Mean profile, not weather or solar-cycle thermosphere', 'γ = 1.4 everywhere for Mach number', 'Optional seeded perturbations are hydrostatically consistent'], applicability: '−5 km to 1000 km tabulated; above, labelled extrapolation.', code: 'src/physics/atmosphere.ts',
  },
  {
    id: 'aero', title: 'Aerodynamic forces and moments', classification: 'engineering-approximation',
    equations: ['q = ½ ρ |v_air|²', 'F_drag = −½ ρ C_D A |v_air| v_air', 'C_N = (C_Nα/2) sin2α cos(α/2) + η C_dc (A_p/A) sin²α (+ fins)', 'C_A = C_A0(M) cosα |cosα|', 'M_cg = (x_cg − x_cp) x̂ × F_N + damping', 'β = m / (C_D A)'],
    sources: ['R7', 'J77'], assumptions: ['Shape-family tables, not vehicle-specific data', 'Bounded high-angle crossflow model', 'Fins: thin-airfoil slope; vanish with q', 'Knudsen bridging to free molecular', 'No Reynolds-number correction'], applicability: 'Flags raised outside the family table domain, at high α, and in rarefied flow.', code: 'src/physics/aero.ts',
  },
  {
    id: 'attitude', title: 'Attitude dynamics (Engineering mode)', classification: 'physical-law',
    equations: ['q̇ = ½ q ⊗ [0, ω_b]', 'I ω̇_b = M − ω_b × (I ω_b)', 'TVC torque ≤ F l sin δ_max; RCS torque ≤ τ_max, consumes propellant'],
    sources: [], assumptions: ['Axisymmetric inertia updated quasi-statically as propellant drains (jet damping neglected)', 'Quaternion renormalised after each step', 'Assisted mode prescribes attitude instead (labelled idealisation)'], applicability: 'Rigid body; no flexible modes.', code: 'src/physics/flight.ts',
  },
  {
    id: 'thermal', title: 'Aerothermal heating and thermal network', classification: 'engineering-approximation',
    equations: ['q_s = k √(ρ / r_n) V³, k = 1.7415e-4 (SI)', 'hot wall: × (T_r − T_w)/(T_r − 300 K); free-molecular bound ½ ρ V³', 'surface loss = ε σ (T⁴ − T_sink⁴)', 'nodes: stagnation surface, backing, body skin, interior'],
    sources: ['R8'], assumptions: ['Hypersonic continuum blunt-nose correlation; flagged at low speed and rarefied flow', 'Local peak flux (stagnation) distinguished from area-averaged body heating', 'Non-ablating presets; ablation deferred', 'Radiative sink 250 K; no solar/Earth IR'], applicability: 'Order-of-magnitude thermal envelopes; not a wall-temperature prediction for real hardware.', code: 'src/physics/thermal.ts',
  },
  {
    id: 'propulsion', title: 'Propulsion and staging', classification: 'physical-law',
    equations: ['ṁ = −F / (Isp g0)', 'Δv_ideal = Isp g0 ln(m0/mf)', 'Isp(p) linear between sea level and vacuum; F = ṁ g0 Isp(p)'],
    sources: ['R10'], assumptions: ['Finite burns; no instantaneous Δv bonus', 'Staging updates mass, geometry, inertia and aero reference', 'Base-drag change with plume not modelled'], applicability: 'Exact for constant exhaust velocity.', code: 'src/physics/propulsion.ts',
  },
  {
    id: 'guidance', title: 'Assisted insertion guidance', classification: 'engineering-approximation',
    equations: ['dh_apo/dt (desired) = (h_target − h_apo) / τ', 'pitch from ∇_v h_apo · a_thrust(γ) = desired rate', 'cut-off when osculating periapsis ≥ cutoff altitude'],
    sources: [], assumptions: ['Chooses only a thrust direction; obeys thrust, gimbal, RCS and propellant limits', 'Reports failure when propulsion is insufficient', 'In-plane only (inclination set by site and azimuth)'], applicability: 'Simple assist, not an optimal ascent.', code: 'src/physics/guidance.ts',
  },
  {
    id: 'orbit', title: 'Osculating orbital elements', classification: 'physical-law',
    equations: ['ε = |v|²/2 − μ/|r|', 'h = r × v; e = (v × h)/μ − r/|r|', 'p = |h|²/μ; r_p = p/(1+e); r_a = 2a − r_p', 'Bound iff ε < 0'],
    sources: ['R9'], assumptions: ['Two-body osculating conic', 'Orbit success requires validation by forward propagation with drag'], applicability: 'Robust for radial, circular, parabolic and hyperbolic cases.', code: 'src/physics/orbit.ts',
  },
  {
    id: 'integrator', title: 'Numerical integration and events', classification: 'engineering-approximation',
    equations: ['Dormand–Prince 5(4), FSAL, PI step control', 'error = ‖e_i / (atol_i + rtol·|y_i|)‖_rms', '4th-order dense output; Illinois root finding for events'],
    sources: [], assumptions: ['Phase-specific step caps justified by convergence tests', 'Events split steps at discontinuities', 'Uncertainty sampled once per run, never per step'], applicability: 'Reproducible within documented tolerances (not bitwise across browsers).', code: 'src/physics/integrator.ts',
  },
  {
    id: 'costs', title: 'Fictional cost model', classification: 'fictional-game-hardware',
    equations: ['per launch = energy + propellant + expended hardware + consumables + refurbishment + capital/500'],
    sources: [], assumptions: ['Game credits, not currency', 'Electricity is only one line of the cost'], applicability: 'Game balance only.', code: 'src/game/costs.ts',
  },
];

export const modelById = (id: string): ModelEntry | undefined => MODELS.find((m) => m.id === id);

export const EXCLUSIONS = [
  'Earth oblateness (J2) and other long-term orbital perturbations',
  'Detailed terrain (uniform site elevation is used everywhere)',
  'Computational fluid dynamics and finite-element structural analysis',
  'Flexible-body vibration and arm bending (envelopes only)',
  'Detailed gas flow at the chamber opening / membrane rupture transient',
  'Ablation and material microphysics (non-ablating presets)',
  'Solar and Earth infrared heating; thermospheric solar-cycle variability',
  'Real weather (the atmosphere is a mean profile with optional seeded perturbations)',
];
