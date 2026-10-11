/** Live consequence strings shown under each control: every edit shows what it changes. */
import type { Scenario } from '../sim/build';
import * as F from './format';

export function consequenceFor(path: string, s: Scenario | null): string | undefined {
  if (!s) return undefined;
  const d = s.derived;
  const v = s.vehicle;
  switch (path) {
    case 'launcher.armRadiusM':
    case 'launcher.targetTipSpeedMps':
      return `ω ${F.num(d.omegaTarget, 2)} rad/s · ${F.num(d.rpm, 1)} rpm · ${F.num(d.aRadialG, 0)} g · arm stress ${F.stress(d.stressMax)} (margin ${F.num(d.stressMargin, 2)}) · spin-up ≈ ${F.duration(d.spinupTimeEstimate)}`;
    case 'flightPlan.elevationDeg':
      return `exit port at rotor phase ${F.num(((s.geometry.phiRelease * 180) / Math.PI) % 360, 1)}° · tunnel exit ${F.length(s.geometry.sEnd)} from release point`;
    case 'vehicle.payloadMassKg':
      return `wet mass ${F.mass(d.wetMass)} · tip mass ${F.mass(d.tipMass)} · β ${F.num(d.ballisticCoefficient, 0)} kg/m² · vehicle KE ${F.energy(d.vehicleKE)}`;
    case 'vehicle.aeroFamilyId':
    case 'vehicle.finsId':
    case 'vehicle.noseBallastKg':
      return `static margin ${F.num(d.stabilityMarginSubsonicCal, 2)} cal (M 0.5) / ${F.num(d.stabilityMarginHypersonicCal, 2)} cal (M 6) · β ${F.num(d.ballisticCoefficient, 0)} kg/m²`;
    case 'vehicle.protectionId':
      return `nose ${v.thermal.noseMaterial.name}, envelope ${v.thermal.noseMaterial.maxTemperatureK} K · wet mass ${F.mass(d.wetMass)}`;
    case 'vehicle.stackId':
      return d.stageDeltaV.length ? `ideal Δv ${F.num(d.idealDeltaV, 0)} m/s (${d.stageDeltaV.map((x) => F.num(x, 0)).join(' + ')}) · stack ${F.length(v.stackLength)}` : 'ballistic: no onboard propulsion';
    case 'flightPlan.guidance.mode':
      return s.guidance.mode === 'none' ? 'unpowered after release' : `${s.guidance.mode} · target apoapsis ${F.km(s.guidance.targetAltitude, 0)}, cutoff periapsis ${F.km(s.guidance.cutoffPeriapsis, 0)}`;
    case 'launcher.chamberRadiusM':
    case 'launcher.chamberDepthM':
    case 'launcher.vacuum.targetPressurePa':
    case 'launcher.vacuum.pumpSpeedM3s':
      return `volume ${F.num(s.vacuum.volume, 0)} m³ · pump-down ${F.duration(d.pump.time)} · gas-drag loss at target ${F.power(d.gasLossPowerAtTarget)}`;
    case 'launcher.arm.materialId':
    case 'launcher.arm.profile':
    case 'launcher.arm.rootAreaM2':
    case 'launcher.arm.tipAreaM2':
      return `arm mass ${F.mass(d.armMass)} · peak stress ${F.stress(d.stressMax)} at ${F.length(d.stressMaxAt)} · margin ${F.num(d.stressMargin, 2)} (SF req. ${s.config.launcher.structure.safetyFactor})`;
    case 'launcher.motorId':
      return `spin-up ≈ ${F.duration(d.spinupTimeEstimate)} using ${F.energy(d.spinupEnergyEstimate)} · max sustainable ${F.mps(d.equilibriumTipSpeed)}`;
    case 'launcher.bearingId':
    case 'launcher.balanceId':
      return `post-release bearing load ${F.force(d.postReleaseBearingLoad)} of ${F.force(d.bearingLimit)} envelope`;
    case 'launcher.mountId':
      return `residual pitch rate at release ≈ ${F.num(d.omegaTarget * s.release.residualFraction, 3)} rad/s`;
    case 'launcher.exit.apertureRadiusM':
    case 'launcher.exit.tunnelLengthM':
    case 'launcher.release.timingOffsetS':
    case 'launcher.release.timingJitterStdS':
      return `radial margin ${F.length(d.apertureMargin)} · timing tolerance ≈ ±${F.duration(d.timingToleranceS)} · ${F.num((d.directionErrorPerMs * 180) / Math.PI, 3)}° per ms`;
    case 'flightPlan.azimuthDeg':
    case 'site.latitudeDeg':
      return `orbit inclination ≈ ${F.num(d.inclinationEstimateDeg, 1)}°`;
    case 'vehicle.lengthM':
    case 'vehicle.diameterM':
      return `L/D ${F.num(d.fineness, 1)} · A_ref ${F.num(v.refArea * 1e4, 0)} cm² · wet ${F.mass(d.wetMass)}`;
    case 'vehicle.noseRadiusM':
      return `stagnation flux ∝ 1/√r_n; nose cap ${F.num(v.noseCapArea * 1e4, 0)} cm²`;
    default:
      return undefined;
  }
}
