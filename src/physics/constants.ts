/**
 * Declared physical constants for the spherical, rotating-Earth model.
 * All internal quantities are SI; angles are radians; temperatures kelvin.
 */
import { prov, type Provenance } from './provenance';

/** Standard gravity, m/s^2 (exact by definition). */
export const G0 = 9.80665;
/** Earth gravitational parameter, m^3/s^2. */
export const MU_EARTH = 3.986004418e14;
/** Spherical-model Earth radius, m (mean radius; a spherical approximation). */
export const R_EARTH = 6_371_000;
/** Earth rotation rate (sidereal), rad/s. */
export const OMEGA_EARTH = 7.292115e-5;
/** Stefan-Boltzmann constant, W/(m^2 K^4). */
export const SIGMA_SB = 5.670374419e-8;
/** Universal gas constant used by USSA76, J/(kmol K) -> scaled below. */
export const R_STAR_USSA76 = 8.31432; // J/(mol K), USSA76 value
/** Sea-level mean molar mass of air (USSA76), kg/mol. */
export const M0_AIR = 0.0289644;
/** Specific gas constant of sea-level air, J/(kg K). */
export const R_AIR = R_STAR_USSA76 / M0_AIR;
/** Ratio of specific heats used for speed of sound (diatomic air). */
export const GAMMA_AIR = 1.4;
/** Boltzmann constant, J/K. */
export const K_BOLTZMANN = 1.380649e-23;
/** Effective collision diameter of an air molecule for mean free path, m. */
export const AIR_MOLECULE_DIAMETER = 3.65e-10;
/** Sea-level standard pressure, Pa. */
export const P0_SEA_LEVEL = 101_325;
/** USSA76 effective Earth radius for geopotential altitude, m. */
export const R0_GEOPOTENTIAL = 6_356_766;

export const CONSTANT_PROVENANCE: Record<string, Provenance> = {
  G0: prov('physical-law', ['R10'], 'Standard gravity, exact by definition (9.80665 m/s^2).'),
  MU_EARTH: prov('published-reference', ['R9'], 'Earth GM, 3.986004418e14 m^3/s^2 (WGS-84/IERS value).'),
  R_EARTH: prov(
    'engineering-approximation',
    ['R9'],
    'Mean spherical radius 6,371 km. The real Earth is oblate; oblateness is excluded from this release.',
  ),
  OMEGA_EARTH: prov('published-reference', ['R9'], 'Sidereal rotation rate 7.2921150e-5 rad/s.'),
  SIGMA_SB: prov('physical-law', [], 'CODATA Stefan-Boltzmann constant.'),
  R_STAR_USSA76: prov('published-reference', ['R6'], 'Gas constant as adopted by USSA76 (8.31432 J/(mol K)).'),
  M0_AIR: prov('published-reference', ['R6'], 'Sea-level mean molar mass of air, USSA76.'),
  GAMMA_AIR: prov(
    'engineering-approximation',
    ['R6'],
    'gamma = 1.4 is used at all altitudes for speed of sound. Above ~86 km the gas becomes partly monatomic; Mach numbers there are approximate.',
  ),
};
