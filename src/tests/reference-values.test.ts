/** Section 8 synthetic reference case: R = 50 m, v_tip = 2,000 m/s (derived values, not SpinLaunch data). */
import { describe, expect, it } from 'vitest';
import { tipKinematics, vehicleTranslationalEnergy } from '../physics/rotor';
import { dynamicPressure } from '../physics/aero';
import { releaseDirectionError } from '../physics/launcher';
import { G0 } from '../physics/constants';

describe('synthetic reference case R = 50 m, v = 2000 m/s', () => {
  const k = tipKinematics(50, 2000);
  it('angular speed 40 rad/s', () => expect(k.omega).toBeCloseTo(40, 12));
  it('rotor speed 381.9719 rpm', () => expect(k.rpm).toBeCloseTo(381.9719, 4));
  it('centripetal acceleration 80,000 m/s^2', () => expect(k.aRadial).toBeCloseTo(80000, 8));
  it('centripetal load 8,157.73 g', () => expect(k.gLoad).toBeCloseTo(8157.73, 2));
  it('uses g0 = 9.80665', () => expect(G0).toBe(9.80665));
  it('200 kg translational energy 400 MJ = 111.111 kWh', () => {
    const e = vehicleTranslationalEnergy(200, 2000);
    expect(e).toBeCloseTo(400e6, 3);
    expect(e / 3.6e6).toBeCloseTo(111.111, 3);
  });
  it('dynamic pressure at 1.225 kg/m^3 is 2.45 MPa', () => expect(dynamicPressure(1.225, 2000)).toBeCloseTo(2.45e6, 3));
  it('1 ms timing error gives 0.04 rad = 2.29183 deg', () => {
    const d = releaseDirectionError(k.omega, 1e-3);
    expect(d).toBeCloseTo(0.04, 12);
    expect((d * 180) / Math.PI).toBeCloseTo(2.29183, 5);
  });
});
