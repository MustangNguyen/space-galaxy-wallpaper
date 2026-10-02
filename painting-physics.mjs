const SPRING = 14;
const DAMPING = 2.3;
const MAX_DT = 1 / 30;
const MAX_SPEED = 2.6;
const MAX_DISPLACEMENT = 1.25;
const MAX_CURSOR_SPEED = 5;
const FLOW_IMPULSE_PER_UNIT = 4.2;

export const PARTICLE_SIZES = Object.freeze([0.65, 0.85, 1, 1.25, 1.55]);
const DEFAULT_SIZE_CLASS = 2;
const SIZE_CLASS_COUNT = PARTICLE_SIZES.length;
const BLOCK_SIZE = 128;

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/**
 * Allocation-free O(N) spring dynamics for particles sampled from a painting.
 *
 * Each xyz triplet has a fixed home. A cursor stroke advects particles through smooth curls near the
 * whole swept segment, while an underdamped spring returns them to that home.
 * The caller should normally advance the simulation at a fixed 1/120 second.
 */
export class PaintingPhysics {
  constructor(homes, sizeClasses = null) {
    if (!(homes instanceof Float32Array)) {
      throw new TypeError('homes must be a Float32Array');
    }
    if (homes.length % 3 !== 0) {
      throw new RangeError('homes must contain xyz triplets');
    }
    for (let i = 0; i < homes.length; i++) {
      if (!Number.isFinite(homes[i])) {
        throw new RangeError('homes must contain only finite values');
      }
    }

    this.count = homes.length / 3;
    this.spring = SPRING;
    this.damping = DAMPING;
    if (sizeClasses !== null && !(sizeClasses instanceof Uint8Array)) {
      throw new TypeError('sizeClasses must be a Uint8Array or null');
    }
    if (sizeClasses !== null && sizeClasses.length !== this.count) {
      throw new RangeError('sizeClasses must contain one class per particle');
    }
    if (sizeClasses !== null) {
      for (let i = 0; i < sizeClasses.length; i++) {
        if (sizeClasses[i] >= SIZE_CLASS_COUNT) {
          throw new RangeError(`size class ${sizeClasses[i]} is out of range`);
        }
      }
    }

    this.homes = new Float32Array(homes);
    this.positions = new Float32Array(homes);
    this.velocities = new Float32Array(homes.length);
    this.sizeClasses = sizeClasses === null
      ? new Uint8Array(this.count).fill(DEFAULT_SIZE_CLASS)
      : new Uint8Array(sizeClasses);
    this.sizes = new Float32Array(this.count);
    this.masses = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const size = PARTICLE_SIZES[this.sizeClasses[i]];
      this.sizes[i] = size;
      this.masses[i] = size * size;
    }

    // Reused coefficient tables avoid allocations and per-particle
    // trigonometry in step().
    this._bounds = new Float32Array(Math.ceil(this.count / BLOCK_SIZE) * 4);
    this._boundsDirty = true;
    this._flow = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const x = this.homes[i * 3], y = this.homes[i * 3 + 1];
      this._flow[i * 3] = Math.sin(x * 11 + y * 7) * Math.cos(y * 9 - x * 5);
      this._flow[i * 3 + 1] = 0.85 + 0.15 * Math.sin(x * 19 + y * 13);
      this._flow[i * 3 + 2] = 0.28 * Math.sin(x * 12 - y * 8);
    }
    this._cosines = new Float64Array(SIZE_CLASS_COUNT);
    this._envelopes = new Float64Array(SIZE_CLASS_COUNT);
    this._decays = new Float64Array(SIZE_CLASS_COUNT);
    this._sineOverOmegas = new Float64Array(SIZE_CLASS_COUNT);
  }

  /**
   * Apply one cursor-movement event as a velocity impulse.
   *
   * `stroke` is null or
   * { fromX, fromY, toX, toY, vx, vy, radius, strength } in painting-world
   * units. Cursor velocity is world units per second. The impulse scales with
   * the travelled distance, so splitting one path into several events gives a
   * similar result instead of multiplying a frame-based force.
   */
  disturb(stroke) {
    if (!stroke || typeof stroke !== 'object' || this.count === 0) return;
    let fromX = 0;
    let fromY = 0;
    let segmentX = 0;
    let segmentY = 0;
    let segmentLengthSq = 0;
    let cursorUnitX = 0;
    let cursorUnitY = 0;
    let cursorSpeed = 0;
    let radius = 0;
    fromX = finiteOr(stroke.fromX, 0);
    fromY = finiteOr(stroke.fromY, 0);
    const toX = finiteOr(stroke.toX, fromX);
    const toY = finiteOr(stroke.toY, fromY);
    segmentX = toX - fromX;
    segmentY = toY - fromY;
    segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
    radius = clamp(finiteOr(stroke.radius, 0), 0, 1);
    const strength = clamp(finiteOr(stroke.strength, 0), 0, 2);
    if (radius <= 0 || strength <= 0 || !(segmentLengthSq > 1e-12)) return;

    const travel = Math.sqrt(segmentLengthSq);
    const cursorVX = finiteOr(stroke.vx, 0);
    const cursorVY = finiteOr(stroke.vy, 0);
    const rawCursorSpeed = Math.hypot(cursorVX, cursorVY);
    if (rawCursorSpeed > 1e-8) {
      cursorUnitX = cursorVX / rawCursorSpeed;
      cursorUnitY = cursorVY / rawCursorSpeed;
      cursorSpeed = Math.min(rawCursorSpeed, MAX_CURSOR_SPEED);
    } else {
      cursorUnitX = segmentX / travel;
      cursorUnitY = segmentY / travel;
      cursorSpeed = Math.min(travel * 60, MAX_CURSOR_SPEED);
    }
    const radiusSq = radius * radius;
    const flowImpulse = Math.min(0.75, travel * FLOW_IMPULSE_PER_UNIT)
      * (0.45 + 0.55 * cursorSpeed / MAX_CURSOR_SPEED) * strength;
    const positions = this.positions;
    const velocities = this.velocities;
    const homes = this.homes;
    const masses = this.masses;

    // Reuse current-position bounds across the resampled strokes in one frame.
    // Conservative boxes keep fast sweeps and displaced particles eligible.
    if (this._boundsDirty) {
      for (let start = 0, block = 0; start < this.count; start += BLOCK_SIZE, block += 4) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const end = Math.min(this.count, start + BLOCK_SIZE);
        for (let i = start * 3; i < end * 3; i += 3) {
          const x = positions[i], y = positions[i + 1];
          if (!Number.isFinite(x + y + positions[i + 2] + velocities[i] + velocities[i + 1] + velocities[i + 2])) {
            minX = minY = -Infinity; maxX = maxY = Infinity; break;
          }
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        this._bounds[block] = minX; this._bounds[block + 1] = minY;
        this._bounds[block + 2] = maxX; this._bounds[block + 3] = maxY;
      }
      this._boundsDirty = false;
    }
    const left = Math.min(fromX, toX) - radius, right = Math.max(fromX, toX) + radius;
    const bottom = Math.min(fromY, toY) - radius, top = Math.max(fromY, toY) + radius;
    for (let start = 0, block = 0; start < this.count; start += BLOCK_SIZE, block += 4) {
      const bounds = this._bounds;
      if (bounds[0 + block] > right || bounds[2 + block] < left || bounds[1 + block] > top || bounds[3 + block] < bottom) continue;
      const end = Math.min(this.count, start + BLOCK_SIZE);
      for (let index = start, offset = start * 3; index < end; offset += 3, index++) {
        let x = positions[offset];
        let y = positions[offset + 1];
        let vx = velocities[offset];
        let vy = velocities[offset + 1];
        let vz = velocities[offset + 2];
        if (!Number.isFinite(x + y + positions[offset + 2] + vx + vy + vz)) {
          x = homes[offset];
          y = homes[offset + 1];
          positions[offset] = x;
          positions[offset + 1] = y;
          positions[offset + 2] = homes[offset + 2];
          vx = 0;
          vy = 0;
          vz = 0;
          velocities[offset] = 0;
          velocities[offset + 1] = 0;
          velocities[offset + 2] = 0;
        }
        let closestT = ((x - fromX) * segmentX + (y - fromY) * segmentY)
          / segmentLengthSq;
        closestT = clamp(closestT, 0, 1);
        const distanceX = x - (fromX + segmentX * closestT);
        const distanceY = y - (fromY + segmentY * closestT);
        const distanceSq = distanceX * distanceX + distanceY * distanceY;
        if (!(distanceSq < radiusSq)) continue;

        // A smooth compact flow field, not a normalised radial shove. Its
        // centre follows the brush; surrounding curls mix the colors without
        // splitting the painting into two banks along the cursor's centreline.
        const qx = distanceX / radius;
        const qy = distanceY / radius;
        const edge = 1 - distanceSq / radiusSq;
        const weight = edge * edge * edge;
        const along = qx * cursorUnitX + qy * cursorUnitY;
        const across = -qx * cursorUnitY + qy * cursorUnitX;
        // Spatially coherent variation forms small eddies instead of random
        // per-frame jitter. Adjacent particles move together, then separate.
        const curl = this._flow[offset];
        const carry = 0.8 - 1.6 * across * across;
        const crossFlow = 1.5 * along * across;
        const perpendicularX = -cursorUnitY;
        const perpendicularY = cursorUnitX;
        const variation = this._flow[offset + 1];
        const inverseMass = 1 / masses[index];
        vx += flowImpulse * weight * variation * inverseMass
          * (cursorUnitX * carry + perpendicularX * crossFlow - qy * curl * 2.8);
        vy += flowImpulse * weight * variation * inverseMass
          * (cursorUnitY * carry + perpendicularY * crossFlow + qx * curl * 2.8);
        // A little depth motion gives the points a soft billowing wake.
        vz += flowImpulse * weight * inverseMass
          * this._flow[offset + 2];
        const speedSq = vx * vx + vy * vy + vz * vz;
        if (speedSq > MAX_SPEED * MAX_SPEED) {
          const scale = MAX_SPEED / Math.sqrt(speedSq);
          vx *= scale;
          vy *= scale;
          vz *= scale;
        }
        velocities[offset] = vx;
        velocities[offset + 1] = vy;
        velocities[offset + 2] = vz;
      }
    }
  }

  setDynamics(spring, damping) {
    this.spring = clamp(finiteOr(spring, this.spring), 0.5, 20);
    this.damping = clamp(finiteOr(damping, this.damping), 0.2, 6);
  }

  /** Advance the spring simulation. `stroke` is accepted for convenience. */
  step(dt, stroke = null) {
    dt = finiteOr(dt, 0);
    if (dt <= 0 || this.count === 0) return;
    dt = Math.min(dt, MAX_DT);
    if (stroke) this.disturb(stroke);
    this._boundsDirty = true;

    // Exact oscillator coefficients, including critical and overdamped settings.
    // Damping scales with sqrt(mass), preserving the damping ratio and
    // making larger particles oscillate more slowly. Only five coefficient
    // sets are evaluated per step.
    const cosines = this._cosines;
    const envelopes = this._envelopes;
    const decays = this._decays;
    const sineOverOmegas = this._sineOverOmegas;
    for (let sizeClass = 0; sizeClass < SIZE_CLASS_COUNT; sizeClass++) {
      const size = PARTICLE_SIZES[sizeClass];
      const inverseSize = 1 / size;
      const decay = this.damping * 0.5 * inverseSize;
      const frequencySq = this.spring / (size * size) - decay * decay;
      const envelope = Math.exp(-decay * dt);
      decays[sizeClass] = decay;
      envelopes[sizeClass] = envelope;
      if (Math.abs(frequencySq) < 1e-8) {
        cosines[sizeClass] = 1;
        sineOverOmegas[sizeClass] = dt;
      } else if (frequencySq > 0) {
        const omega = Math.sqrt(frequencySq);
        cosines[sizeClass] = Math.cos(omega * dt);
        sineOverOmegas[sizeClass] = Math.sin(omega * dt) / omega;
      } else {
        const omega = Math.sqrt(-frequencySq);
        cosines[sizeClass] = Math.cosh(omega * dt);
        sineOverOmegas[sizeClass] = Math.sinh(omega * dt) / omega;
      }
    }

    const homes = this.homes;
    const positions = this.positions;
    const velocities = this.velocities;
    const sizeClasses = this.sizeClasses;
    const masses = this.masses;

    for (let offset = 0, index = 0; offset < positions.length; offset += 3, index++) {
      const homeX = homes[offset];
      const homeY = homes[offset + 1];
      const homeZ = homes[offset + 2];
      let x = positions[offset];
      let y = positions[offset + 1];
      let z = positions[offset + 2];
      let vx = velocities[offset];
      let vy = velocities[offset + 1];
      let vz = velocities[offset + 2];

      // Most of a dense painting is untouched. Skip the oscillator arithmetic
      // for resting particles and let tiny residual motion settle exactly.
      if (x === homeX && y === homeY && z === homeZ && vx === 0 && vy === 0 && vz === 0) continue;
      const restDistanceSq = (x - homeX) ** 2 + (y - homeY) ** 2 + (z - homeZ) ** 2;
      if (restDistanceSq < 1e-12 && vx * vx + vy * vy + vz * vz < 1e-12) {
        positions[offset] = homeX;
        positions[offset + 1] = homeY;
        positions[offset + 2] = homeZ;
        velocities[offset] = 0;
        velocities[offset + 1] = 0;
        velocities[offset + 2] = 0;
        continue;
      }

      if (!Number.isFinite(x + y + z + vx + vy + vz)) {
        x = homeX;
        y = homeY;
        z = homeZ;
        vx = 0;
        vy = 0;
        vz = 0;
      }

      // Solve x'' + DAMPING*x' + SPRING*(x-home) = 0 exactly.
      let displacementX = x - homeX;
      let displacementY = y - homeY;
      let displacementZ = z - homeZ;

      const sizeClass = sizeClasses[index];
      const cosine = cosines[sizeClass];
      const envelope = envelopes[sizeClass];
      const decay = decays[sizeClass];
      const sineOverOmega = sineOverOmegas[sizeClass];
      const springAcceleration = this.spring / masses[index];

      let nextX = envelope * (displacementX * cosine
        + (vx + decay * displacementX) * sineOverOmega);
      let nextY = envelope * (displacementY * cosine
        + (vy + decay * displacementY) * sineOverOmega);
      let nextZ = envelope * (displacementZ * cosine
        + (vz + decay * displacementZ) * sineOverOmega);
      let nextVX = envelope * (vx * cosine
        - (decay * vx + springAcceleration * displacementX) * sineOverOmega);
      let nextVY = envelope * (vy * cosine
        - (decay * vy + springAcceleration * displacementY) * sineOverOmega);
      let nextVZ = envelope * (vz * cosine
        - (decay * vz + springAcceleration * displacementZ) * sineOverOmega);

      let speedSq = nextVX * nextVX + nextVY * nextVY + nextVZ * nextVZ;
      if (speedSq > MAX_SPEED * MAX_SPEED) {
        const scale = MAX_SPEED / Math.sqrt(speedSq);
        nextVX *= scale;
        nextVY *= scale;
        nextVZ *= scale;
      }

      const displacementSq = nextX * nextX + nextY * nextY + nextZ * nextZ;
      if (displacementSq > MAX_DISPLACEMENT * MAX_DISPLACEMENT) {
        const scale = MAX_DISPLACEMENT / Math.sqrt(displacementSq);
        nextX *= scale;
        nextY *= scale;
        nextZ *= scale;
      }

      positions[offset] = homeX + nextX;
      positions[offset + 1] = homeY + nextY;
      positions[offset + 2] = homeZ + nextZ;
      velocities[offset] = nextVX;
      velocities[offset + 1] = nextVY;
      velocities[offset + 2] = nextVZ;
    }
  }

  reset() {
    this._boundsDirty = true;
    this.positions.set(this.homes);
    this.velocities.fill(0);
  }
}
