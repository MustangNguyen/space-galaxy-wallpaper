import assert from 'node:assert/strict';
import test from 'node:test';

import { InteractionSampler } from './interaction-sampler.mjs';

function collect(sampler, now, limit = 32) {
  const samples = [];
  const count = sampler.drain(now, sample => samples.push({ ...sample }), limit);
  assert.equal(count, samples.length);
  return samples;
}

function runStraightSecond(hz) {
  const sampler = new InteractionSampler(hz);
  const samples = [];
  for (let frame = 0; frame <= 60; frame++) {
    const time = frame * (1000 / 60);
    sampler.push(time / 1000, 0, time);
    sampler.drain(time, sample => samples.push({ ...sample }));
  }
  return samples;
}

test('produces exact selectable rates from the same 60 Hz one-second stroke', () => {
  for (const hz of [30, 60, 120, 240]) {
    const samples = runStraightSecond(hz);
    assert.equal(samples.length, hz, `${hz} Hz sample count`);
    assert.ok(Math.abs(samples.at(-1).toX - 1) < 1e-12);
    assert.ok(Math.abs(samples.at(-1).time - 1000) < 1e-9);
  }
});

test('interpolates sparse input at evenly spaced target timestamps', () => {
  const sampler = new InteractionSampler(120);
  sampler.push(0, 0, 0);
  sampler.push(1, 0.5, 1000 / 30);
  const samples = collect(sampler, 1000 / 30);

  assert.equal(samples.length, 4);
  for (let i = 0; i < samples.length; i++) {
    const fraction = (i + 1) / 4;
    assert.ok(Math.abs(samples[i].toX - fraction) < 1e-12);
    assert.ok(Math.abs(samples[i].toY - fraction * 0.5) < 1e-12);
    assert.ok(Math.abs(samples[i].time - (i + 1) * (1000 / 120)) < 1e-9);
    assert.ok(Math.hypot(samples[i].vx, samples[i].vy) <= 12 + 1e-12);
  }
});

test('flushes a final stroke shorter than one interval without extrapolation', () => {
  const sampler = new InteractionSampler(120);
  sampler.push(0, 0, 10);
  sampler.push(0.04, -0.02, 14);

  assert.equal(collect(sampler, 14).length, 0);
  const samples = collect(sampler, 24);
  assert.equal(samples.length, 1);
  assert.deepEqual(
    [samples[0].fromX, samples[0].fromY, samples[0].toX, samples[0].toY],
    [0, 0, 0.04, -0.02],
  );
  assert.ok(samples[0].time > 14);
});

test('does not emit duplicate impulses for a stationary pointer', () => {
  const sampler = new InteractionSampler(240);
  sampler.push(0.25, -0.5, 0);
  for (let time = 5; time <= 150; time += 5) {
    sampler.push(0.25, -0.5, time);
    assert.equal(collect(sampler, time).length, 0);
  }
  assert.equal(collect(sampler, 199).length, 0);
});

test('limits callbacks per drain without dropping sustained 240 Hz input at 30 FPS', () => {
  const sampler = new InteractionSampler(240);
  let total = 0;
  sampler.push(0, 0, 0);
  for (let frame = 1; frame <= 30; frame++) {
    const frameTime = frame * (1000 / 30);
    for (let event = (frame - 1) * 8 + 1; event <= frame * 8; event++) {
      const time = event * (1000 / 240);
      sampler.push(time / 1000, 0, time);
    }
    const count = sampler.drain(frameTime, () => {}, 32);
    assert.ok(count <= 32);
    total += count;
  }
  assert.equal(total, 240);
});

test('frequent renders do not consume 240 Hz slots between 30 Hz raw events', () => {
  const sampler = new InteractionSampler(240);
  const samples = [];
  sampler.push(0, 0, 0);

  for (let tick = 1; tick <= 240; tick++) {
    const time = tick * (1000 / 240);
    if (tick % 8 === 0) sampler.push(time / 1000, 0, time);
    sampler.drain(time, sample => samples.push({ ...sample }));
  }

  assert.equal(samples.length, 240);
  assert.ok(samples.every((sample, index) =>
    Math.abs(sample.time - (index + 1) * (1000 / 240)) < 1e-8));
  assert.ok(Math.abs(samples.at(-1).toX - 1) < 1e-12);
});

test('a lone anchor cannot advance the sample timeline before movement arrives', () => {
  const sampler = new InteractionSampler(240);
  sampler.push(3, -1, 0);
  for (let time = 1000 / 240; time < 80; time += 1000 / 240) {
    assert.equal(collect(sampler, time).length, 0);
  }
  sampler.push(4, -1, 100);
  const samples = collect(sampler, 100);
  assert.equal(samples.length, 24);
  assert.equal(samples[0].fromX, 3);
  assert.ok(Math.abs(samples.at(-1).toX - 4) < 1e-12);
});

test('resets stale and backwards trails instead of bridging them', () => {
  const sampler = new InteractionSampler(120);
  sampler.push(0, 0, 0);
  sampler.push(1, 0, 4);
  assert.equal(collect(sampler, 205).length, 0, 'stale trail expired');

  sampler.push(10, 0, 300);
  sampler.push(20, 0, 250);
  sampler.push(21, 0, 260);
  const samples = collect(sampler, 260);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].fromX, 20);
  assert.ok(Math.abs(samples[0].toX - 20.833333333333332) < 1e-12);

  sampler.push(100, 0, 500);
  sampler.push(101, 0, 510);
  const afterGap = collect(sampler, 510);
  assert.equal(afterGap.length, 1);
  assert.equal(afterGap[0].fromX, 100);
});

test('changing rate clears pending input and starts a fresh trail', () => {
  const sampler = new InteractionSampler(30);
  sampler.push(0, 0, 0);
  sampler.push(1, 0, 20);
  sampler.setRate(240);
  assert.equal(collect(sampler, 40).length, 0);

  sampler.push(5, 0, 50);
  sampler.push(6, 0, 55);
  const samples = collect(sampler, 55);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].fromX, 5);
  assert.equal(samples[0].toX, 5 + (1000 / 240) / 5);
});

test('reuses one callback object and validates supported rates', () => {
  const sampler = new InteractionSampler(120);
  const references = [];
  sampler.push(0, 0, 0);
  sampler.push(1, 0, 20);
  sampler.drain(20, sample => references.push(sample));
  assert.ok(references.length > 1);
  assert.ok(references.every(sample => sample === references[0]));
  assert.throws(() => new InteractionSampler(100), RangeError);
  assert.throws(() => sampler.setRate(0), RangeError);
});
