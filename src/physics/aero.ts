/**
 * Reduced-order aerodynamics for axisymmetric bodies.
 *
 * Coefficients are referenced to the body base (maximum cross-section) area
 * A_ref = pi D^2 / 4, consistent with the drag equation [R7]:
 *     F_drag = 0.5 rho V^2 C_D A_ref.
 *
 * Small-angle coefficients come from per-family Mach tables (engineering
 * approximations, not wind-tunnel data for any real vehicle). Large angles use
 * a bounded crossflow model of the Jorgensen type (NASA TR R-474, 1977):
 *     C_N = (C_Nalpha/2) sin(2a) cos(a/2) + eta C_dc(M sin a) (A_p/A_ref) sin^2 a
 * plus a stalled flat-plate term for fins, so tumbling never extrapolates a
 * small-angle slope. Free-molecular limits are bridged smoothly in Knudsen
 * number. All of these are labelled approximations with stated domains.
 */
import { prov, type Provenance } from './provenance';

export interface AeroFamily {
  id: string;
  name: string;
  description: string;
  provenance: Provenance;
  nose: 'ogive' | 'cone' | 'hemisphere' | 'flat';
  /** Nose length in calibers (used for geometry/area and CP placement). */
  noseLengthCalibers: number;
  /** Maximum nose radius as a fraction of the body diameter. */
  maxNoseRadiusFraction: number;
  mach: number[];
  /** Power-off axial force coefficient at zero incidence (includes base drag). */
  cd0: number[];
  /** Body normal-force slope at zero incidence, per rad. */
  cnAlpha: number[];
  /** Body potential-flow centre of pressure / body length from the nose. */
  xcpFrac: number[];
  /** Axial coefficient when flying base-first. */
  cdBackward: number;
  /** Crossflow drag coefficient vs crossflow Mach number. */
  crossflowMach: number[];
  crossflowCd: number[];
  /** Crossflow efficiency factor eta. */
  eta: number;
  /** Planform area = factor * L * D. */
  planformFactor: number;
  /** Planform centroid / L from the nose. */
  planformCentroidFrac: number;
  /** Area-averaged body convective heating as a fraction of stagnation flux. */
  bodyHeatingFraction: number;
  applicability: { machMax: number; finenessMin: number; finenessMax: number; reliableAlphaDeg: number };
}

const M = [0, 0.6, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5, 2.0, 3.0, 4.0, 6.0, 10.0, 25.0];
const CFM = [0, 0.4, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, 5.0, 10.0, 25.0];
const CFD = [1.2, 1.2, 1.4, 1.7, 1.75, 1.6, 1.45, 1.35, 1.3, 1.3, 1.3];

const APPROX_AERO = (detail: string): Provenance =>
  prov(
    'engineering-approximation',
    ['R7', 'J77'],
    `${detail} Shape-family table assembled from generic projectile/missile trends; not data for any specific vehicle. Uncertainty roughly +/-20 % in C_D and +/-30 % in C_N slope.`,
    0.15,
  );

export const AERO_FAMILIES: Record<string, AeroFamily> = {
  'slender-ogive': {
    id: 'slender-ogive',
    name: 'Slender tangent-ogive cylinder',
    description: '3-caliber tangent-ogive nose on a cylinder (L/D ~ 8-14). Low drag; centre of pressure far forward, so body-alone is statically unstable without fins.',
    provenance: APPROX_AERO('Slender ogive-cylinder family.'),
    nose: 'ogive',
    noseLengthCalibers: 3,
    maxNoseRadiusFraction: 0.25,
    mach: M,
    cd0: [0.12, 0.12, 0.13, 0.17, 0.33, 0.38, 0.37, 0.33, 0.28, 0.22, 0.19, 0.165, 0.15, 0.15],
    cnAlpha: [2.0, 2.0, 2.05, 2.1, 2.2, 2.25, 2.25, 2.3, 2.3, 2.3, 2.3, 2.3, 2.3, 2.3],
    xcpFrac: [0.13, 0.13, 0.13, 0.14, 0.15, 0.16, 0.16, 0.16, 0.17, 0.18, 0.19, 0.2, 0.2, 0.2],
    cdBackward: 0.9,
    crossflowMach: CFM,
    crossflowCd: CFD,
    eta: 0.68,
    planformFactor: 0.93,
    planformCentroidFrac: 0.56,
    bodyHeatingFraction: 0.03,
    applicability: { machMax: 25, finenessMin: 7, finenessMax: 16, reliableAlphaDeg: 20 },
  },
  'blunted-cone': {
    id: 'blunted-cone',
    name: 'Blunted 8-degree cone with short cylinder',
    description: 'Sphere-capped cone over most of the length (like a ballistic re-entry body). Higher drag; centre of pressure near 60 % of length, so it can be statically stable without fins.',
    provenance: APPROX_AERO('Blunted slender-cone family (Newtonian-trend hypersonic values).'),
    nose: 'cone',
    noseLengthCalibers: 3.5,
    maxNoseRadiusFraction: 0.35,
    mach: M,
    cd0: [0.24, 0.24, 0.27, 0.33, 0.46, 0.5, 0.49, 0.43, 0.36, 0.29, 0.26, 0.23, 0.22, 0.22],
    cnAlpha: [1.95, 1.95, 1.95, 2.0, 2.0, 2.0, 2.0, 1.98, 1.96, 1.95, 1.95, 1.94, 1.94, 1.94],
    xcpFrac: [0.5, 0.5, 0.51, 0.52, 0.54, 0.56, 0.57, 0.58, 0.59, 0.6, 0.6, 0.6, 0.6, 0.6],
    cdBackward: 1.0,
    crossflowMach: CFM,
    crossflowCd: CFD,
    eta: 0.62,
    planformFactor: 0.62,
    planformCentroidFrac: 0.62,
    bodyHeatingFraction: 0.05,
    applicability: { machMax: 25, finenessMin: 3, finenessMax: 10, reliableAlphaDeg: 25 },
  },
  'hemisphere-cylinder': {
    id: 'hemisphere-cylinder',
    name: 'Hemisphere-nosed cylinder',
    description: 'Blunt hemispherical nose on a cylinder. Very high wave drag (C_D near 0.9 hypersonic) and heavy heating relief from the large nose radius.',
    provenance: APPROX_AERO('Hemisphere-cylinder family (modified-Newtonian hypersonic C_D ~ 0.92).'),
    nose: 'hemisphere',
    noseLengthCalibers: 0.5,
    maxNoseRadiusFraction: 0.5,
    mach: M,
    cd0: [0.35, 0.36, 0.45, 0.6, 0.85, 0.95, 0.98, 1.0, 0.98, 0.95, 0.93, 0.92, 0.92, 0.92],
    cnAlpha: [1.6, 1.6, 1.7, 1.75, 1.8, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85],
    xcpFrac: [0.08, 0.08, 0.08, 0.09, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
    cdBackward: 0.9,
    crossflowMach: CFM,
    crossflowCd: CFD,
    eta: 0.68,
    planformFactor: 0.97,
    planformCentroidFrac: 0.52,
    bodyHeatingFraction: 0.06,
    applicability: { machMax: 25, finenessMin: 4, finenessMax: 16, reliableAlphaDeg: 20 },
  },
  'stack-cylinder': {
    id: 'stack-cylinder',
    name: 'Exposed upper-stage stack (flat-topped cylinder)',
    description: 'Geometry after the aeroshell is jettisoned. Only meaningful at negligible dynamic pressure.',
    provenance: APPROX_AERO('Flat-faced cylinder; used only after aeroshell jettison.'),
    nose: 'flat',
    noseLengthCalibers: 0,
    maxNoseRadiusFraction: 0.5,
    mach: M,
    cd0: [0.8, 0.8, 0.9, 1.0, 1.15, 1.3, 1.4, 1.5, 1.55, 1.6, 1.6, 1.6, 1.6, 1.6],
    cnAlpha: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    xcpFrac: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05],
    cdBackward: 1.0,
    crossflowMach: CFM,
    crossflowCd: CFD,
    eta: 0.7,
    planformFactor: 1.0,
    planformCentroidFrac: 0.5,
    bodyHeatingFraction: 0.05,
    applicability: { machMax: 25, finenessMin: 1, finenessMax: 20, reliableAlphaDeg: 10 },
  },
};

export interface FinPreset {
  id: string;
  name: string;
  /** Number of panels (cruciform = 4). */
  panels: number;
  /** Exposed panel area as a multiple of D^2. */
  panelAreaPerD2: number;
  /** Exposed semi-span as a multiple of D. */
  spanPerD: number;
  /** Panel mass per unit panel area (kg/m^2), including root fitting. */
  arealMassKgM2: number;
  /** Thickness-to-chord ratio (wave drag). */
  thicknessRatio: number;
  provenance: Provenance;
}

export const FIN_PRESETS: Record<string, FinPreset> = {
  none: {
    id: 'none',
    name: 'No fins',
    panels: 0,
    panelAreaPerD2: 0,
    spanPerD: 0,
    arealMassKgM2: 0,
    thicknessRatio: 0,
    provenance: prov('fictional-game-hardware', [], 'No stabilising surfaces.'),
  },
  'small-tail': {
    id: 'small-tail',
    name: 'Small cruciform tail fins',
    panels: 4,
    panelAreaPerD2: 0.55,
    spanPerD: 0.55,
    arealMassKgM2: 45,
    thicknessRatio: 0.06,
    provenance: prov('fictional-game-hardware', ['J77'], 'Generic swept trapezoidal panels; slope from thin-airfoil theory (Ackeret supersonic).'),
  },
  'large-tail': {
    id: 'large-tail',
    name: 'Large cruciform tail fins',
    panels: 4,
    panelAreaPerD2: 1.1,
    spanPerD: 0.8,
    arealMassKgM2: 45,
    thicknessRatio: 0.06,
    provenance: prov('fictional-game-hardware', ['J77'], 'Generic swept trapezoidal panels; slope from thin-airfoil theory (Ackeret supersonic).'),
  },
};

/** Dynamic pressure q = 0.5 rho V^2 (Pa). */
export const dynamicPressure = (rho: number, v: number): number => 0.5 * rho * v * v;

/** Drag force vector -0.5 rho Cd A |v| v for air-relative velocity v. */
export function dragForce(rho: number, cd: number, area: number, v: [number, number, number]): [number, number, number] {
  const s = Math.hypot(v[0], v[1], v[2]);
  const k = -0.5 * rho * cd * area * s;
  return [k * v[0], k * v[1], k * v[2]];
}

export function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + f * (ys[hi] - ys[lo]);
}

/** Geometry needed by the aerodynamic model. */
export interface AeroGeometry {
  family: AeroFamily;
  fins: FinPreset;
  length: number;
  diameter: number;
  refArea: number;
}

/** Normal-force slope of one fin pair vs Mach, per rad, on the pair planform area. */
export function finPairSlope(mach: number, aspectRatio: number): number {
  const sub = (2 * Math.PI * aspectRatio) / (2 + Math.sqrt(aspectRatio * aspectRatio + 4));
  const sup = (m: number): number => 4 / Math.sqrt(m * m - 1);
  if (mach <= 0.8) return sub;
  if (mach >= 1.2) return Math.min(sub, sup(mach));
  const a = sub, b = Math.min(sub, sup(1.2));
  return a + ((mach - 0.8) / 0.4) * (b - a);
}

export interface FinGeometry {
  panelArea: number;
  span: number;
  meanChord: number;
  /** Fin centre of pressure from the nose (m). */
  xcp: number;
  mass: number;
  aspectRatioPair: number;
}

export function finGeometry(fins: FinPreset, length: number, diameter: number): FinGeometry {
  if (fins.panels === 0) return { panelArea: 0, span: 0, meanChord: 0, xcp: length, mass: 0, aspectRatioPair: 0 };
  const panelArea = fins.panelAreaPerD2 * diameter * diameter;
  const span = fins.spanPerD * diameter;
  const meanChord = panelArea / span;
  return {
    panelArea,
    span,
    meanChord,
    xcp: length - 0.55 * meanChord,
    mass: fins.panels * panelArea * fins.arealMassKgM2,
    aspectRatioPair: (2 * span * 2 * span) / (2 * panelArea),
  };
}

export interface AeroCoefficients {
  /** Axial force coefficient (positive pushes toward -x_body). */
  ca: number;
  /** Normal force coefficient (positive opposes the transverse velocity). */
  cn: number;
  /** Centre of pressure of the normal force from the nose (m). */
  xcp: number;
  /** Small-angle total normal-force slope (per rad) and its CP (m) - for stability margin. */
  cnAlphaTotal: number;
  xcpSmallAlpha: number;
  /** Pitch-damping derivative C_mq about the given CG (per rad, ref length L, negative = damping). */
  cmq: number;
  /** 0 = continuum, 1 = free molecular. */
  rarefactionWeight: number;
  /** Bit flags of applicability warnings (see AERO_FLAG_*). */
  flags: number;
}

export const AERO_FLAG_HIGH_ALPHA = 1;
export const AERO_FLAG_RAREFIED = 2;
export const AERO_FLAG_FINENESS = 4;
export const AERO_FLAG_MACH = 8;

const smoothstep = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Aerodynamic coefficients for total angle of attack alpha in [0, pi].
 * @param knudsen mean free path / body length
 * @param xcg centre of gravity from nose (m), for damping derivative
 */
export function aeroCoefficients(
  g: AeroGeometry,
  mach: number,
  alpha: number,
  knudsen: number,
  xcg: number,
  out: AeroCoefficients,
): AeroCoefficients {
  const fam = g.family;
  const L = g.length, D = g.diameter, A = g.refArea;
  const ca0 = interp(fam.mach, fam.cd0, mach);
  const cnaBody = interp(fam.mach, fam.cnAlpha, mach);
  const xcpBody = interp(fam.mach, fam.xcpFrac, mach) * L;
  const sa = Math.sin(alpha), ca = Math.cos(alpha);
  // Body terms
  const cnPot = (cnaBody / 2) * Math.sin(2 * alpha) * Math.cos(alpha / 2);
  const cdc = interp(fam.crossflowMach, fam.crossflowCd, mach * sa);
  const ap = fam.planformFactor * L * D;
  const cnVisc = fam.eta * cdc * (ap / A) * sa * sa;
  const xPot = alpha <= Math.PI / 2 ? xcpBody : L - 0.15 * L;
  const xVisc = fam.planformCentroidFrac * L;
  // Fin terms
  const fg = finGeometry(g.fins, L, D);
  let cnaFin = 0, cnFin = 0, dCaFin = 0;
  if (g.fins.panels > 0) {
    const pairArea = 2 * fg.panelArea;
    const interference = 1 + D / (2 * fg.span + D);
    cnaFin = interference * finPairSlope(mach, fg.aspectRatioPair) * (pairArea / A);
    // Linear part (vanishes broadside) + stalled flat-plate part (bounded).
    cnFin = cnaFin * sa * ca + 2 * (pairArea / A) * sa * sa;
    const tc = g.fins.thicknessRatio;
    const panelCd = mach > 1.05 ? 0.012 + (4 * tc * tc) / Math.sqrt(mach * mach - 1) : mach > 0.85 ? 0.03 : 0.012;
    dCaFin = g.fins.panels * (fg.panelArea / A) * Math.min(panelCd, 0.06);
  }
  // Continuum totals
  const caAxial0 = ca >= 0 ? ca0 + dCaFin : fam.cdBackward + dCaFin;
  let caC = caAxial0 * ca * Math.abs(ca);
  let cnC = cnPot + cnVisc + cnFin;
  const momentC = cnPot * xPot + cnVisc * xVisc + cnFin * fg.xcp;
  // Free-molecular limit (diffuse reflection, hypersonic): C ~ 2.2 on projected areas.
  const w = knudsen > 0 ? smoothstep((Math.log10(knudsen) + 2) / 3) : 0;
  let xcp: number;
  if (w > 0) {
    const caF = 2.2 * ca * Math.abs(ca);
    const cnF = 2.2 * (ap / A) * sa * sa;
    const momentF = cnF * xVisc;
    caC = (1 - w) * caC + w * caF;
    const cnTot = (1 - w) * cnC + w * cnF;
    const mom = (1 - w) * momentC + w * momentF;
    cnC = cnTot;
    xcp = Math.abs(cnTot) > 1e-9 ? mom / cnTot : xVisc;
  } else {
    xcp = Math.abs(cnC) > 1e-9 ? momentC / cnC : (cnaBody * xcpBody + cnaFin * fg.xcp) / (cnaBody + cnaFin);
  }
  const cnaTot = cnaBody + cnaFin;
  const xcpSmall = (cnaBody * xcpBody + cnaFin * fg.xcp) / cnaTot;
  // Damping: each lifting element sees an induced incidence omega*(x_i - x_cg)/V.
  const lb = (xcpBody - xcg) / L;
  const lf = (fg.xcp - xcg) / L;
  // The crossflow term has zero slope at zero incidence, so it adds no linear damping.
  const cmq = -2 * (cnaBody * lb * lb + cnaFin * lf * lf) * (1 - w);
  let flags = 0;
  if (alpha > (fam.applicability.reliableAlphaDeg * Math.PI) / 180) flags |= AERO_FLAG_HIGH_ALPHA;
  if (w > 0.01) flags |= AERO_FLAG_RAREFIED;
  const fineness = L / D;
  if (fineness < fam.applicability.finenessMin || fineness > fam.applicability.finenessMax) flags |= AERO_FLAG_FINENESS;
  if (mach > fam.applicability.machMax) flags |= AERO_FLAG_MACH;
  out.ca = caC;
  out.cn = cnC;
  out.xcp = xcp;
  out.cnAlphaTotal = cnaTot;
  out.xcpSmallAlpha = xcpSmall;
  out.cmq = cmq;
  out.rarefactionWeight = w;
  out.flags = flags;
  return out;
}

export function emptyAeroCoefficients(): AeroCoefficients {
  return { ca: 0, cn: 0, xcp: 0, cnAlphaTotal: 0, xcpSmallAlpha: 0, cmq: 0, rarefactionWeight: 0, flags: 0 };
}

export const AERO_PROVENANCE = prov(
  'engineering-approximation',
  ['R7', 'J77'],
  'Drag equation with Mach-dependent shape-family tables; Jorgensen-type crossflow for large angles; fin slopes from thin-airfoil theory; damping from element induced incidence; smooth Knudsen bridging to a free-molecular limit (C = 2.2 on projected area). No Reynolds-number correction: tables assume high-Reynolds turbulent flow.',
);
