# Sources

Starting references for the models, plus notes on how each is used. The same list is embedded in the app (`src/data/sources.ts`) and linked from the model inspector.

| Key | Source | Used for |
|---|---|---|
| R1 | SpinLaunch, public system description — https://www.spinlaunch.com/ | Scale references only (proposed 100 m chamber, up to 8,000 km/h release with onboard propulsion; separate 33 m suborbital system). Not an engineering specification. |
| R2 | MDN, Using Web Workers — https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers | Simulation and prediction run in dedicated workers. |
| R3 | Vite, Features: Web Workers — https://vite.dev/guide/features#web-workers | `new Worker(new URL('./workers/simulation.worker.ts', import.meta.url), { type: 'module' })` pattern. |
| R4 | MDN, JavaScript Number — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number | Double-precision kernel. |
| R5 | Three.js, WebGLRenderer — https://threejs.org/docs/pages/WebGLRenderer.html | WebGL2 rendering (three 0.186.0). |
| R6 | U.S. Standard Atmosphere, 1976 (NOAA/NASA/USAF; NASA TM-X-74335) — https://ntrs.nasa.gov/citations/19770009539 ; https://www.ngdc.noaa.gov/stp/space-weather/online-publications/miscellaneous/us-standard-atmosphere-1976/us-standard-atmosphere_st76-1562_noaa.pdf | Layer constants 0–86 km; Table I pressure and density 86–1000 km (transcribed, interpolated log-linearly); upper temperature segments. |
| R7 | NASA Glenn, The Drag Equation — https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/drag-equation/ | Drag force convention and reference area. |
| R8 | NASA TFAWS 2012, Aerothermodynamics Course (printed slides 17 and 28) — https://tfaws.nasa.gov/TFAWS12/Proceedings/Aerothermodynamics%20Course.pdf | Sutton-Graves stagnation heating (k = 1.7415e-4 SI); radiative re-emission. |
| R9 | NASA, Basics of Space Flight, Chapter 3 — https://science.nasa.gov/learn/basics-of-space-flight/chapter3-1/ (and 3-2, 3-3) | Two-body mechanics, orbital elements; why a single ground impulse cannot give an orbit. |
| R10 | NASA Glenn, Ideal Rocket Equation — https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/ideal-rocket-equation/ | Rocket equation and mass flow. |
| J77 | L. H. Jorgensen, *Prediction of Static Aerodynamic Characteristics for Slender Bodies Alone and with Lifting Surfaces to Very High Angles of Attack*, NASA TR R-474, 1977 | Functional form of the bounded high-angle crossflow model. The coefficients used here are generic approximations, not values from the report. |
| H1 | Typical engineering-handbook magnitudes (no single dataset) | Material densities, strengths and thermal properties in presets. Representative values with stated uncertainty, not certified allowables. |

## Data and licences

- No scientific datasets are downloaded at runtime. The USSA76 values used are transcribed constants and a 22-row table from a U.S. Government publication (public domain), embedded in `src/physics/atmosphere.ts` and checked by `src/tests/atmosphere.test.ts`.
- Software dependencies (pinned in `package.json`/`package-lock.json`): React 19.2.8 and React DOM (MIT), Three.js 0.186.0 (MIT), Vite 7.3.7 (MIT), TypeScript 5.9.3 (Apache-2.0), Vitest 4.0.18 (MIT), Playwright 1.56.1 (Apache-2.0).
- The URLs above are recorded for the reader; the application does not fetch them.
