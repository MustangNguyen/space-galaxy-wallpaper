const TAU = Math.PI * 2;
const GALAXY_SPEED = 0.62;
const GALAXY_CORE_SQ = 0.36;
const VERTICAL_FREQUENCY_SQ = 0.52;
const MAX_RADIUS_SQ = 400;
const HOLE_MU = 5;
const MAX_HOLE_ACCELERATION = 42;
const FADE_IN_RATE = 1.6;

function clamp01(value) {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * O(N) particle dynamics for a thin galaxy disk.
 *
 * The galaxy is a static softened logarithmic potential. It gives every
 * particle inertia and an orbit without the O(N²) cost of particle-to-particle
 * gravity. A moving cursor adds a local, softened inverse-square field.
 */
export class GalaxyPhysics {
  constructor(count, { random = Math.random } = {}) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError('count must be a non-negative integer');
    }
    if (typeof random !== 'function') {
      throw new TypeError('random must be a function');
    }

    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.visibility = new Float32Array(count);

    this._fade = new Float32Array(count);
    this._random = random;
    this._previousHoleX = 0;
    this._previousHoleY = 0;
    this._previousHoleZ = 0;
    this._holeWasActive = false;

    for (let i = 0; i < count; i++) {
      this._spawn(i, false);
    }
  }

  _unitRandom() {
    const value = this._random();
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value >= 1 ? 0.9999999999999999 : value;
  }

  _spawn(index, recycled) {
    // Fresh particles fill the disk. Recycled particles return through its
    // outer third so a capture cannot visibly pop near the event horizon.
    const u = this._unitRandom();
    const radius = recycled
      ? 4.4 + 1.6 * u
      : 0.18 + 5.82 * Math.pow(u, 1.35);
    const arm = index & 3;
    const armJitter = (this._unitRandom() - 0.5) * (0.18 + radius * 0.10);
    const angle = arm * (TAU / 4) + radius * 1.55 + armJitter;
    const vertical = (this._unitRandom() - 0.5) * (0.055 + radius * 0.018);
    const radialJitter = (this._unitRandom() - 0.5) * (0.05 + radius * 0.018);
    const tangentJitter = (this._unitRandom() - 0.5) * 0.035;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const offset = index * 3;

    this.positions[offset] = cos * radius;
    this.positions[offset + 1] = vertical;
    this.positions[offset + 2] = sin * radius;

    // Circular speed for Phi = .5*v0²*log(core² + R²).
    const circularSpeed = GALAXY_SPEED * radius / Math.sqrt(GALAXY_CORE_SQ + radius * radius);
    this.velocities[offset] = -sin * (circularSpeed + tangentJitter) + cos * radialJitter;
    this.velocities[offset + 1] = -vertical * 0.12 + (this._unitRandom() - 0.5) * 0.018;
    this.velocities[offset + 2] = cos * (circularSpeed + tangentJitter) + sin * radialJitter;

    this._fade[index] = recycled ? 0 : 1;
    this.visibility[index] = recycled ? 0 : 1;
  }

  /**
   * Advance the simulation. For best stability call with fixed dt <= 1/120.
   * `hole` may be null, or { x, y, z, strength, radius, captureRadius }.
   */
  step(dt, hole = null) {
    dt = finiteOr(dt, 0);
    if (dt <= 0 || this.count === 0) return;
    // A delayed browser frame must not inject enough energy to destroy orbits.
    if (dt > 1 / 60) dt = 1 / 60;

    let holeStrength = 0;
    let holeX = 0;
    let holeY = 0;
    let holeZ = 0;
    let holeRadius = 0;
    let captureRadius = 0;

    if (hole && typeof hole === 'object') {
      holeStrength = clamp01(finiteOr(hole.strength, 0));
      holeX = finiteOr(hole.x, 0);
      holeY = finiteOr(hole.y, 0);
      holeZ = finiteOr(hole.z, 0);
      holeRadius = Math.max(0, finiteOr(hole.radius, 0));
      captureRadius = Math.max(0, finiteOr(hole.captureRadius, 0));
      if (holeRadius <= 0) holeStrength = 0;
      if (captureRadius > holeRadius) captureRadius = holeRadius;
    }

    const holeActive = holeStrength > 0;
    const previousHoleX = this._holeWasActive ? this._previousHoleX : holeX;
    const previousHoleY = this._holeWasActive ? this._previousHoleY : holeY;
    const previousHoleZ = this._holeWasActive ? this._previousHoleZ : holeZ;
    const radiusSq = holeRadius * holeRadius;
    const captureSq = captureRadius * captureRadius;
    const softening = Math.max(0.12, captureRadius * 0.8);
    const softeningSq = softening * softening;
    const halfDt = dt * 0.5;

    const positions = this.positions;
    const velocities = this.velocities;
    const visibility = this.visibility;
    const fade = this._fade;

    for (let i = 0, offset = 0; i < this.count; i++, offset += 3) {
      let x = positions[offset];
      let y = positions[offset + 1];
      let z = positions[offset + 2];
      const oldX = x;
      const oldY = y;
      const oldZ = z;
      let vx = velocities[offset];
      let vy = velocities[offset + 1];
      let vz = velocities[offset + 2];

      let radialSq = x * x + z * z;
      let galaxyFactor = -(GALAXY_SPEED * GALAXY_SPEED) / (GALAXY_CORE_SQ + radialSq);
      let ax = galaxyFactor * x;
      let ay = -VERTICAL_FREQUENCY_SQ * y;
      let az = galaxyFactor * z;

      if (holeActive) {
        const dx = holeX - x;
        const dy = holeY - y;
        const dz = holeZ - z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq < radiusSq) {
          const q = distanceSq / radiusSq;
          const edge = 1 - q;
          let factor = HOLE_MU * holeStrength * edge * edge
            / Math.pow(distanceSq + softeningSq, 1.5);
          const acceleration = factor * Math.sqrt(distanceSq);
          if (acceleration > MAX_HOLE_ACCELERATION) {
            factor *= MAX_HOLE_ACCELERATION / acceleration;
          }
          ax += dx * factor;
          ay += dy * factor;
          az += dz * factor;
        }
      }

      vx += ax * halfDt;
      vy += ay * halfDt;
      vz += az * halfDt;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;

      let captured = false;
      if (holeActive && captureRadius > 0) {
        // In relative coordinates, both cursor motion and a fast particle are
        // one segment. This prevents either one tunnelling through the horizon.
        const relativeStartX = oldX - previousHoleX;
        const relativeStartY = oldY - previousHoleY;
        const relativeStartZ = oldZ - previousHoleZ;
        const relativeEndX = x - holeX;
        const relativeEndY = y - holeY;
        const relativeEndZ = z - holeZ;
        const relativeStepX = relativeEndX - relativeStartX;
        const relativeStepY = relativeEndY - relativeStartY;
        const relativeStepZ = relativeEndZ - relativeStartZ;
        const relativeStepLengthSq = relativeStepX * relativeStepX
          + relativeStepY * relativeStepY + relativeStepZ * relativeStepZ;
        let segmentT = 0;
        if (relativeStepLengthSq > 1e-12) {
          segmentT = -(relativeStartX * relativeStepX
            + relativeStartY * relativeStepY
            + relativeStartZ * relativeStepZ) / relativeStepLengthSq;
          segmentT = clamp01(segmentT);
        }
        const captureX = relativeStartX + relativeStepX * segmentT;
        const captureY = relativeStartY + relativeStepY * segmentT;
        const captureZ = relativeStartZ + relativeStepZ * segmentT;
        captured = captureX * captureX + captureY * captureY + captureZ * captureZ <= captureSq;
      }

      radialSq = x * x + z * z;
      if (captured || x * x + y * y + z * z > MAX_RADIUS_SQ
          || !Number.isFinite(x + y + z + vx + vy + vz)) {
        this._spawn(i, true);
        continue;
      }

      galaxyFactor = -(GALAXY_SPEED * GALAXY_SPEED) / (GALAXY_CORE_SQ + radialSq);
      ax = galaxyFactor * x;
      ay = -VERTICAL_FREQUENCY_SQ * y;
      az = galaxyFactor * z;

      let horizonVisibility = 1;
      if (holeActive) {
        const dx = holeX - x;
        const dy = holeY - y;
        const dz = holeZ - z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq < radiusSq) {
          const q = distanceSq / radiusSq;
          const edge = 1 - q;
          let factor = HOLE_MU * holeStrength * edge * edge
            / Math.pow(distanceSq + softeningSq, 1.5);
          const acceleration = factor * Math.sqrt(distanceSq);
          if (acceleration > MAX_HOLE_ACCELERATION) {
            factor *= MAX_HOLE_ACCELERATION / acceleration;
          }
          ax += dx * factor;
          ay += dy * factor;
          az += dz * factor;

          // Mild drag in the inner field lets particles lose enough angular
          // momentum to cross the horizon while retaining natural inertia.
          const drag = Math.exp(-0.75 * holeStrength * edge * edge * dt);
          vx *= drag;
          vy *= drag;
          vz *= drag;

          if (captureRadius > 0) {
            const distance = Math.sqrt(distanceSq);
            const fadeWidth = Math.max(captureRadius * 2.5, 0.12);
            let horizonFade = clamp01((distance - captureRadius) / fadeWidth);
            horizonFade = horizonFade * horizonFade * (3 - 2 * horizonFade);
            horizonVisibility = 1 - holeStrength * (1 - horizonFade);
          }
        }
      }

      vx += ax * halfDt;
      vy += ay * halfDt;
      vz += az * halfDt;

      const nextFade = Math.min(1, fade[i] + FADE_IN_RATE * dt);
      fade[i] = nextFade;
      visibility[i] = nextFade * horizonVisibility;
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
      velocities[offset] = vx;
      velocities[offset + 1] = vy;
      velocities[offset + 2] = vz;
    }

    this._holeWasActive = holeActive;
    if (holeActive) {
      this._previousHoleX = holeX;
      this._previousHoleY = holeY;
      this._previousHoleZ = holeZ;
    }
  }
}
