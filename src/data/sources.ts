/** Reference sources cited by models and presets. */
export interface SourceRef {
  key: string;
  title: string;
  url: string;
  note: string;
}

export const SOURCES: SourceRef[] = [
  { key: 'R1', title: 'SpinLaunch, public system description', url: 'https://www.spinlaunch.com/', note: 'Scale references only (proposed 100 m chamber, up to 8,000 km/h release; separate 33 m suborbital system). Not an engineering specification; this game is not a digital twin.' },
  { key: 'R2', title: 'MDN, Using Web Workers', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers', note: 'Simulation runs in dedicated workers.' },
  { key: 'R3', title: 'Vite, Features: Web Workers', url: 'https://vite.dev/guide/features#web-workers', note: 'Module-worker construction pattern.' },
  { key: 'R4', title: 'MDN, JavaScript Number', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number', note: 'IEEE-754 double precision for the physics kernel.' },
  { key: 'R5', title: 'Three.js, WebGLRenderer', url: 'https://threejs.org/docs/pages/WebGLRenderer.html', note: 'WebGL2 rendering.' },
  { key: 'R6', title: 'NASA/NOAA/USAF, U.S. Standard Atmosphere, 1976 (NASA TM-X-74335, NTRS 19770009539)', url: 'https://ntrs.nasa.gov/citations/19770009539', note: 'Layer constants 0-86 km; Table I values 86-1000 km; mean profile, not weather.' },
  { key: 'R7', title: 'NASA Glenn, The Drag Equation', url: 'https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/drag-equation/', note: 'D = 0.5 rho V^2 Cd A with Cd referenced to the stated area.' },
  { key: 'R8', title: 'NASA TFAWS 2012, Aerothermodynamics Course (printed slides 17 and 28)', url: 'https://tfaws.nasa.gov/TFAWS12/Proceedings/Aerothermodynamics%20Course.pdf', note: 'Sutton-Graves stagnation heating, k = 1.7415e-4 SI for Earth; radiative equilibrium.' },
  { key: 'R9', title: 'NASA, Basics of Space Flight, Chapter 3: Gravity & Mechanics', url: 'https://science.nasa.gov/learn/basics-of-space-flight/chapter3-1/', note: 'Two-body orbits, orbital elements, why a single ground impulse cannot produce a circular orbit.' },
  { key: 'R10', title: 'NASA Glenn, Ideal Rocket Equation', url: 'https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/ideal-rocket-equation/', note: 'dv = Isp g0 ln(m0/mf).' },
  { key: 'J77', title: 'L. H. Jorgensen, Prediction of Static Aerodynamic Characteristics for Slender Bodies Alone and with Lifting Surfaces to Very High Angles of Attack, NASA TR R-474, 1977', url: 'https://ntrs.nasa.gov/search?q=Jorgensen%20TR%20R-474', note: 'Form of the crossflow (high-angle) normal-force model; coefficients here are generic approximations.' },
  { key: 'H1', title: 'Typical engineering handbook magnitudes (no single dataset)', url: '', note: 'Material densities, strengths and thermal properties are representative values, not certified allowables; uncertainty stated per preset.' },
];

export const sourceByKey = (k: string): SourceRef | undefined => SOURCES.find((s) => s.key === k);
