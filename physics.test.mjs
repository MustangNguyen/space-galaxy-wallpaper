import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { GalaxyPhysics } from './physics.mjs';

function seededRandom(seed = 0x12345678) {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function energyAt(physics, index = 0) {
  const offset = index * 3;
  const x = physics.positions[offset];
  const y = physics.positions[offset + 1];
  const z = physics.positions[offset + 2];
  const vx = physics.velocities[offset];
  const vy = physics.velocities[offset + 1];
  const vz = physics.velocities[offset + 2];
  return 0.5 * (vx * vx + vy * vy + vz * vz)
    + 0.5 * 0.62 ** 2 * Math.log(0.36 + x * x + z * z)
    + 0.5 * 0.52 * y * y;
}

test('creates deterministic typed particle buffers in a thin spiral disk', () => {
  const a = new GalaxyPhysics(128, { random: seededRandom(7) });
  const b = new GalaxyPhysics(128, { random: seededRandom(7) });

  assert.ok(a.positions instanceof Float32Array);
  assert.ok(a.velocities instanceof Float32Array);
  assert.ok(a.visibility instanceof Float32Array);
  assert.equal(a.positions.length, 128 * 3);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.velocities, b.velocities);
  assert.ok(a.positions.every(Number.isFinite));
  assert.ok(a.visibility.every((value) => value === 1));
});

test('leapfrog keeps a circular orbit stable with low energy drift', () => {
  const physics = new GalaxyPhysics(1, { random: seededRandom(1) });
  const radius = 4;
  physics.positions.set([radius, 0, 0]);
  physics.velocities.set([0, 0, 0.62 * radius / Math.sqrt(0.36 + radius * radius)]);
  const initialEnergy = energyAt(physics);
  let minimumRadius = Infinity;
  let maximumRadius = 0;

  for (let i = 0; i < 120 * 60; i++) {
    physics.step(1 / 120);
    const currentRadius = Math.hypot(physics.positions[0], physics.positions[2]);
    minimumRadius = Math.min(minimumRadius, currentRadius);
    maximumRadius = Math.max(maximumRadius, currentRadius);
  }

  assert.ok(maximumRadius - minimumRadius < 0.015, `radial drift ${maximumRadius - minimumRadius}`);
  assert.ok(Math.abs(energyAt(physics) - initialEnergy) < 2e-5);
});

test('the local black hole accelerates particles toward the cursor', () => {
  const physics = new GalaxyPhysics(1, { random: seededRandom(2) });
  physics.positions.set([1, 0, 0]);
  physics.velocities.fill(0);

  physics.step(1 / 120, { x: 0, y: 0, z: 0, strength: 1, radius: 1.8, captureRadius: 0.1 });

  assert.ok(physics.velocities[0] < -0.01, `vx was ${physics.velocities[0]}`);
  assert.ok(physics.positions[0] < 1);
});

test('particle inertia remains after the cursor field is removed', () => {
  const physics = new GalaxyPhysics(1, { random: seededRandom(3) });
  physics.positions.set([1, 0, 0]);
  physics.velocities.fill(0);
  const hole = { x: 0, y: 0, z: 0, strength: 1, radius: 1.8, captureRadius: 0.1 };
  for (let i = 0; i < 8; i++) physics.step(1 / 120, hole);
  const velocityBeforeRemoval = physics.velocities[0];
  const positionBeforeRemoval = physics.positions[0];

  physics.step(1 / 120, null);

  assert.ok(physics.positions[0] < positionBeforeRemoval);
  assert.ok(physics.velocities[0] < 0);
  assert.ok(Math.abs(physics.velocities[0] - velocityBeforeRemoval) < 0.01);
});

test('a swept event horizon captures, recycles, and fades a particle back in', () => {
  const physics = new GalaxyPhysics(1, { random: seededRandom(4) });
  physics.positions.set([-0.5, 0, 0]);
  physics.velocities.fill(0);
  physics.step(1 / 120, { x: -1, y: 0, z: 0, strength: 1, radius: 1.8, captureRadius: 0.12 });
  physics.positions.set([0, 0, 0]);
  physics.velocities.fill(0);

  physics.step(1 / 120, { x: 1, y: 0, z: 0, strength: 1, radius: 1.8, captureRadius: 0.12 });

  assert.ok(Math.hypot(physics.positions[0], physics.positions[2]) >= 4.4);
  assert.equal(physics.visibility[0], 0);
  for (let i = 0; i < 90; i++) physics.step(1 / 120);
  assert.ok(physics.visibility[0] > 0.99);
});

test('a fast particle cannot tunnel through a stationary event horizon', () => {
  const physics = new GalaxyPhysics(1, { random: seededRandom(8) });
  physics.positions.set([-0.2, 0, 0]);
  physics.velocities.set([60, 0, 0]);

  physics.step(1 / 120, { x: 0, y: 0, z: 0, strength: 1, radius: 1.8, captureRadius: 0.05 });

  assert.ok(Math.hypot(physics.positions[0], physics.positions[2]) >= 4.4);
  assert.equal(physics.visibility[0], 0);
});

test('event-horizon fading follows the black-hole strength', () => {
  const weak = new GalaxyPhysics(1, { random: seededRandom(9) });
  weak.positions.set([0.12, 0, 0]);
  weak.velocities.fill(0);
  weak.step(1 / 120, { x: 0, y: 0, z: 0, strength: 0.01, radius: 1.8, captureRadius: 0.1 });

  assert.ok(weak.visibility[0] > 0.98, `visibility was ${weak.visibility[0]}`);
});

test('bad and extreme hole values never produce non-finite state', () => {
  const physics = new GalaxyPhysics(256, { random: seededRandom(5) });
  const cases = [
    { x: NaN, y: Infinity, z: -Infinity, strength: Infinity, radius: NaN, captureRadius: -1 },
    { x: 0, y: 0, z: 0, strength: 1e9, radius: 1e9, captureRadius: 0 },
    { x: 1e12, y: -1e12, z: 1e12, strength: 1, radius: 1e12, captureRadius: 1e12 },
  ];
  for (let frame = 0; frame < 240; frame++) {
    physics.step(frame % 2 ? 1 / 120 : 100, cases[frame % cases.length]);
  }
  assert.ok(physics.positions.every(Number.isFinite));
  assert.ok(physics.velocities.every(Number.isFinite));
  assert.ok(physics.visibility.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
});

test('12k particle step benchmark stays suitable for a low-end CPU', (t) => {
  const physics = new GalaxyPhysics(12_000, { random: seededRandom(6) });
  const hole = { x: 1, y: 0, z: -1, strength: 1, radius: 1.8, captureRadius: 0.1 };
  for (let i = 0; i < 10; i++) physics.step(1 / 120, hole);

  const start = performance.now();
  for (let i = 0; i < 60; i++) physics.step(1 / 120, hole);
  const millisecondsPerStep = (performance.now() - start) / 60;
  t.diagnostic(`12k particles: ${millisecondsPerStep.toFixed(2)} ms/step`);
  assert.ok(millisecondsPerStep < 30, `step took ${millisecondsPerStep.toFixed(2)} ms`);
});
