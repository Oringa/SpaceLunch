/**
 * Failure labels and small formatters shared by the session (worker side)
 * and the interface. Kept separate so the main bundle does not pull in the
 * session and flight model.
 */
export type FailureKind =
  | 'component-load'
  | 'structural-limit'
  | 'bearing-envelope'
  | 'exit-collision'
  | 'aero-overload'
  | 'thermal-envelope'
  | 'unstable-flight'
  | 'propellant-exhausted'
  | 'ground-contact'
  | 'numerical';

export const FAILURE_LABEL: Record<FailureKind, string> = {
  'component-load': 'Component load envelope exceeded',
  'structural-limit': 'Modelled structural limit exceeded',
  'bearing-envelope': 'Bearing transient-load envelope exceeded',
  'exit-collision': 'Exit clearance failed',
  'aero-overload': 'Aerodynamic overload',
  'thermal-envelope': 'Thermal envelope exceeded',
  'unstable-flight': 'Unstable flight outside the allowed envelope',
  'propellant-exhausted': 'Propellant exhausted before target',
  'ground-contact': 'Ground contact before objective',
  'numerical': 'Numerical integration failure',
};

export const fmtPa = (p: number): string => (p >= 1000 ? `${(p / 1000).toPrecision(3)} kPa` : p >= 1 ? `${p.toPrecision(3)} Pa` : `${p.toExponential(1)} Pa`);
