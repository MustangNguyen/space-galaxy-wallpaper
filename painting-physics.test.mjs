import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { PARTICLE_SIZES, PaintingPhysics } from './painting-physics.mjs';

const DT = 1 / 120;

function particleDistance(physics, index) {
  const offset = index * 3;
  return Math.hypot(
    physics.positions[offset] - physics.homes[offset],
    physics.positions[offset + 1] - physics.homes[offset + 1],
    physics.positions[offset + 2] - physics.homes[offset + 2],
  );
}

test('copies homes and remains exactly stable without a force', () => {
  const source = new Float32Array([-1, 0.4, 0, 0.25, -0.6, 0.1]);
  const physics = new PaintingPhysics(source);
  source.fill(99);

  assert.ok(physics.positions instanceof Float32Array);
  assert.ok(physics.velocities instanceof Float32Array);
  assert.ok(physics.homes instanceof Float32Array);
  assert.deepEqual(PARTICLE_SIZES, [0.65, 0.85, 1, 1.25, 1.55]);
  assert.deepEqual(Array.from(physics.sizeClasses), [2, 2]);
  assert.deepEqual(Array.from(physics.sizes), [1, 1]);
  assert.deepEqual(Array.from(physics.masses), [1, 1]);
  assert.deepEqual(Array.from(physics.homes), [-1, 0.4000000059604645, 0, 0.25, -0.6000000238418579, 0.10000000149011612]);

  for (let i = 0; i < 12 / DT; i++) physics.step(DT);
  assert.deepEqual(physics.positions, physics.homes);
  assert.ok(physics.velocities.every((value) => value === 0));
});

test('size classes are copied and validated', () => {
  const classes = new Uint8Array([0, 4]);
  const physics = new PaintingPhysics(new Float32Array([0, 0, 0, 1, 0, 0]), classes);
  classes.fill(2);

  assert.deepEqual(Array.from(physics.sizeClasses), [0, 4]);
  assert.ok(Math.abs(physics.sizes[0] - 0.65) < 1e-6);
  assert.ok(Math.abs(physics.sizes[1] - 1.55) < 1e-6);
  assert.ok(Math.abs(physics.masses[0] - 0.65 ** 2) < 1e-6);
  assert.ok(Math.abs(physics.masses[1] - 1.55 ** 2) < 1e-6);
  assert.throws(() => new PaintingPhysics(new Float32Array(3), [2]), TypeError);
  assert.throws(() => new PaintingPhysics(new Float32Array(3), new Uint8Array(2)), RangeError);
  assert.throws(() => new PaintingPhysics(new Float32Array(3), new Uint8Array([5])), RangeError);
});

test('the same cursor impulse accelerates small particles more than large ones', () => {
  const physics = new PaintingPhysics(
    new Float32Array([0, 0.03, 0, 0, 0.03, 0]),
    new Uint8Array([0, 4]),
  );
  physics.disturb({
    fromX: -0.04, fromY: 0, toX: 0.04, toY: 0,
    vx: 0.5, vy: 0, radius: 0.12, strength: 0.1,
  });

  const smallSpeed = Math.hypot(...physics.velocities.subarray(0, 3));
  const largeSpeed = Math.hypot(...physics.velocities.subarray(3, 6));
  const expectedRatio = physics.masses[1] / physics.masses[0];
  assert.ok(Math.abs(smallSpeed / largeSpeed - expectedRatio) < 1e-5,
    `impulse ratio ${smallSpeed / largeSpeed}, expected ${expectedRatio}`);
});

test('large particles have a lower spring oscillation frequency', () => {
  const physics = new PaintingPhysics(
    new Float32Array([0, 0, 0, 0, 0, 0]),
    new Uint8Array([0, 4]),
  );
  physics.positions[0] = 0.1;
  physics.positions[3] = 0.1;

  let smallCrossing = -1;
  let largeCrossing = -1;
  for (let i = 1; i <= 240; i++) {
    physics.step(DT);
    if (smallCrossing < 0 && physics.positions[0] < 0) smallCrossing = i;
    if (largeCrossing < 0 && physics.positions[3] < 0) largeCrossing = i;
  }

  assert.ok(smallCrossing > 0, `small crossing ${smallCrossing}`);
  assert.ok(largeCrossing > smallCrossing,
    `large crossing ${largeCrossing}, small crossing ${smallCrossing}`);
});

test('all particle sizes stay finite and settle after twelve seconds', () => {
  const homes = new Float32Array(PARTICLE_SIZES.length * 3);
  const classes = new Uint8Array(PARTICLE_SIZES.length);
  const physics = new PaintingPhysics(homes, classes.map((_, index) => index));
  for (let i = 0; i < physics.count; i++) {
    physics.positions[i * 3] = 0.2;
    physics.velocities[i * 3 + 1] = 0.3;
  }

  for (let i = 0; i < 12 / DT; i++) physics.step(DT);

  assert.ok(physics.positions.every(Number.isFinite));
  assert.ok(physics.velocities.every(Number.isFinite));
  for (let i = 0; i < physics.count; i++) {
    assert.ok(particleDistance(physics, i) < 1e-4,
      `class ${i} distance ${particleDistance(physics, i)}`);
  }
});

test('a fast swept stroke affects particles at the middle of its path', () => {
  const physics = new PaintingPhysics(new Float32Array([0, 0.03, 0]));
  physics.step(DT, {
    fromX: -1,
    fromY: 0,
    toX: 1,
    toY: 0,
    vx: 240,
    vy: 0,
    radius: 0.12,
    strength: 1,
  });

  assert.ok(particleDistance(physics, 0) > 0.001, `distance ${particleDistance(physics, 0)}`);
  assert.ok(Math.hypot(...physics.velocities) > 0.01, `velocity ${physics.velocities}`);
  assert.ok(physics.velocities[0] > 0, `along-stroke velocity ${physics.velocities[0]}`);
});

test('the stroke velocity field is continuous through its centerline', () => {
  const epsilon = 1e-5;
  const physics = new PaintingPhysics(new Float32Array([
    0, -epsilon, 0,
    0, 0, 0,
    0, epsilon, 0,
  ]));
  physics.disturb({
    fromX: -0.1,
    fromY: 0,
    toX: 0.1,
    toY: 0,
    vx: 3,
    vy: 0,
    radius: 0.12,
    strength: 1,
  });

  const belowVX = physics.velocities[0];
  const belowVY = physics.velocities[1];
  const centerVX = physics.velocities[3];
  const centerVY = physics.velocities[4];
  const aboveVX = physics.velocities[6];
  const aboveVY = physics.velocities[7];
  const acrossCenterDifference = Math.hypot(aboveVX - belowVX, aboveVY - belowVY);

  assert.ok(centerVX > 0.01, `expected centerline drag along the stroke, vx ${centerVX}`);
  assert.ok(Math.abs(centerVY) < 1e-6, `expected no centerline sideways kick, vy ${centerVY}`);
  assert.ok(belowVX > 0 && aboveVX > 0, 'expected no low-velocity trench beside the centerline');
  assert.ok(acrossCenterDifference < 0.01,
    `expected a continuous field across centerline, difference ${acrossCenterDifference}`);
});

test('particles outside the cursor radius are unaffected', () => {
  const homes = new Float32Array([0, 0.03, 0, 0, 0.5, 0]);
  const physics = new PaintingPhysics(homes);
  physics.step(DT, {
    fromX: -1,
    fromY: 0,
    toX: 1,
    toY: 0,
    vx: 2,
    vy: 0,
    radius: 0.12,
    strength: 1,
  });

  assert.ok(particleDistance(physics, 0) > 0);
  assert.equal(particleDistance(physics, 1), 0);
});

test('a cursor disturbance overshoots and settles back at home', () => {
  const physics = new PaintingPhysics(new Float32Array([0.04, 0, 0]));
  const stroke = {
    fromX: -0.05,
    fromY: 0,
    toX: 0.05,
    toY: 0,
    vx: 3,
    vy: 0,
    radius: 0.12,
    strength: 1,
  };
  physics.step(DT, stroke);
  assert.ok(particleDistance(physics, 0) > 0);
  const initialVelocity = [physics.velocities[0], physics.velocities[1], physics.velocities[2]];
  const initialSpeed = Math.hypot(...initialVelocity);
  assert.ok(initialSpeed > 0);

  let crossedHome = false;
  for (let i = 0; i < 12 / DT; i++) {
    physics.step(DT);
    const displacementAlongInitialMotion = (
      (physics.positions[0] - physics.homes[0]) * initialVelocity[0]
      + (physics.positions[1] - physics.homes[1]) * initialVelocity[1]
      + (physics.positions[2] - physics.homes[2]) * initialVelocity[2]
    ) / initialSpeed;
    if (displacementAlongInitialMotion < -1e-6) crossedHome = true;
  }

  assert.ok(crossedHome, 'expected underdamped motion to cross home');
  assert.ok(particleDistance(physics, 0) < 1e-5, `distance ${particleDistance(physics, 0)}`);
  assert.ok(Math.hypot(...physics.velocities) < 1e-5);
});

test('subdividing one path produces a comparable impulse direction', () => {
  const homes = new Float32Array([0, 0.04, 0]);
  const whole = new PaintingPhysics(homes);
  const split = new PaintingPhysics(homes);
  whole.disturb({ fromX: -0.06, fromY: 0, toX: 0.06, toY: 0, vx: 3, vy: 0, radius: 0.14, strength: 1 });
  split.disturb({ fromX: -0.06, fromY: 0, toX: 0, toY: 0, vx: 3, vy: 0, radius: 0.14, strength: 1 });
  split.disturb({ fromX: 0, fromY: 0, toX: 0.06, toY: 0, vx: 3, vy: 0, radius: 0.14, strength: 1 });

  assert.ok(whole.velocities[0] > 0 && split.velocities[0] > 0);
  const wholeSpeed = Math.hypot(whole.velocities[0], whole.velocities[1]);
  const splitSpeed = Math.hypot(split.velocities[0], split.velocities[1]);
  const directionSimilarity = (
    whole.velocities[0] * split.velocities[0]
    + whole.velocities[1] * split.velocities[1]
  ) / (wholeSpeed * splitSpeed);
  assert.ok(directionSimilarity > 0.95, `direction similarity ${directionSimilarity}`);
  assert.ok(splitSpeed / wholeSpeed > 0.7);
  assert.ok(splitSpeed / wholeSpeed < 1.8);
});

test('a stationary cursor sample does not destabilize particles', () => {
  const homes = new Float32Array([0, 0, 0, 0.04, -0.02, 0]);
  const physics = new PaintingPhysics(homes);
  const stationaryStroke = {
    fromX: 0,
    fromY: 0,
    toX: 0,
    toY: 0,
    vx: 0,
    vy: 0,
    radius: 0.12,
    strength: 1,
  };

  for (let i = 0; i < 120; i++) physics.step(DT, stationaryStroke);

  assert.deepEqual(physics.positions, homes);
  assert.ok(physics.velocities.every((value) => value === 0));
});

test('extreme input stays finite and bounded', () => {
  const physics = new PaintingPhysics(new Float32Array([0, 0, 0, 1, 1, 0]));
  physics.positions[0] = Infinity;
  physics.velocities[1] = NaN;
  const hostileStroke = {
    fromX: -1e300,
    fromY: 1e300,
    toX: 1e300,
    toY: -1e300,
    vx: Infinity,
    vy: -Infinity,
    radius: 1e300,
    strength: 1e300,
  };

  for (let i = 0; i < 120; i++) physics.step(i & 1 ? 1e300 : DT, hostileStroke);

  assert.ok(physics.positions.every(Number.isFinite));
  assert.ok(physics.velocities.every(Number.isFinite));
  for (let i = 0; i < physics.count; i++) {
    assert.ok(particleDistance(physics, i) <= 1.251);
    const offset = i * 3;
    assert.ok(Math.hypot(
      physics.velocities[offset],
      physics.velocities[offset + 1],
      physics.velocities[offset + 2],
    ) <= 4.501);
  }
});

test('reset restores motion while retaining particle sizes and masses', () => {
  const homes = new Float32Array([-0.2, 0.1, 0, 0.6, -0.3, 0]);
  const physics = new PaintingPhysics(homes, new Uint8Array([0, 4]));
  const originalSizes = new Float32Array(physics.sizes);
  const originalMasses = new Float32Array(physics.masses);
  physics.positions.fill(4);
  physics.velocities.fill(-3);

  physics.reset();

  assert.deepEqual(physics.positions, homes);
  assert.ok(physics.velocities.every((value) => value === 0));
  assert.deepEqual(physics.sizes, originalSizes);
  assert.deepEqual(physics.masses, originalMasses);
});

test('12k and 48k particle benchmarks are reported for tuning', (t) => {
  function benchmark(count) {
    const homes = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const offset = i * 3;
      homes[offset] = (i % 320) / 120 - 1.33;
      homes[offset + 1] = Math.floor(i / 320) / 75 - 1;
    }
    const sizeClasses = new Uint8Array(count);
    for (let i = 0; i < count; i++) sizeClasses[i] = i % PARTICLE_SIZES.length;
    const physics = new PaintingPhysics(homes, sizeClasses);
    const stroke = {
      fromX: -0.6,
      fromY: -0.2,
      toX: 0.6,
      toY: 0.2,
      vx: 3,
      vy: 1,
      radius: 0.12,
      strength: 1,
    };
    for (let i = 0; i < 10; i++) physics.step(DT, stroke);

    const start = performance.now();
    for (let i = 0; i < 60; i++) physics.step(DT, stroke);
    return {
      millisecondsPerStep: (performance.now() - start) / 60,
      physics,
    };
  }

  const baseline = benchmark(12_000);
  const dense = benchmark(48_000);
  t.diagnostic(`12k painting particles: ${baseline.millisecondsPerStep.toFixed(2)} ms/step`);
  t.diagnostic(`48k heterogeneous painting particles: ${dense.millisecondsPerStep.toFixed(2)} ms/step`);
  t.diagnostic(`48k/12k cost ratio: ${(dense.millisecondsPerStep / baseline.millisecondsPerStep).toFixed(2)}x`);

  assert.ok(baseline.physics.positions.every(Number.isFinite));
  assert.ok(dense.physics.positions.every(Number.isFinite));
});

test('live dynamics stay finite and dissipate energy across slider extremes', () => {
  for (const [spring, damping] of [[0.5, 0.2], [0.5, 6], [20, 0.2], [20, 6], [4, 4], [6, 2.3]]) {
    const p = new PaintingPhysics(new Float32Array(15), new Uint8Array([0, 1, 2, 3, 4]));
    p.positions.fill(0.1);
    p.velocities.fill(0.2);
    const before = Array.from(p.positions);
    p.setDynamics(spring, damping);
    assert.deepEqual(Array.from(p.positions), before, 'changing controls must not reset the painting');
    const energy = () => p.positions.reduce((sum, x, i) => sum + spring * x * x + p.masses[Math.floor(i / 3)] * p.velocities[i] ** 2, 0);
    let previous = energy();
    for (let i = 0; i < 1200; i++) {
      p.step(DT);
      const next = energy();
      assert.ok(Number.isFinite(next) && next <= previous + 1e-7, `${spring}/${damping}: energy must decay`);
      previous = next;
    }
  }
});

test('block culling matches a full scan across movement, edges and reset', () => {
  const homes = new Float32Array(1024 * 3);
  for (let i = 0; i < 1024; i++) {
    homes[i * 3] = (i % 32) / 16 - 1;
    homes[i * 3 + 1] = Math.floor(i / 32) / 16 - 1;
  }
  const culled = new PaintingPhysics(homes);
  const full = new PaintingPhysics(homes);
  for (let frame = 0; frame < 90; frame++) {
    if (frame === 45) { culled.reset(); full.reset(); }
    for (let k = 0; k < 4; k++) {
      // Disable only the broad phase in the reference; use identical force math.
      for (let b = 0; b < full._bounds.length; b += 4) {
        full._bounds[b] = full._bounds[b + 1] = -Infinity;
        full._bounds[b + 2] = full._bounds[b + 3] = Infinity;
      }
      full._boundsDirty = false;
      const x = Math.sin((frame * 4 + k) * 0.07);
      const stroke = {fromX:x, fromY:-0.6, toX:x+0.03, toY:0.6, vx:1, vy:2, radius:0.14, strength:1};
      culled.disturb(stroke); full.disturb(stroke);
    }
    culled.step(DT); full.step(DT);
    assert.deepEqual(culled.positions, full.positions);
    assert.deepEqual(culled.velocities, full.velocities);
  }
});
