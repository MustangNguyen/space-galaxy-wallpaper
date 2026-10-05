import { InteractionSampler } from '../wallpaper/interaction-sampler.mjs';
import { PaintingPhysics } from '../wallpaper/painting-physics.mjs';

const physics = new PaintingPhysics(
  new Float32Array([0, 0.03, 0, 0.2, -0.1, 0.02]),
  new Uint8Array([0, 4]),
);
physics.setDynamics(0.5, 0.2);
physics.disturb({
  fromX: -0.08, fromY: -0.01, toX: 0.11, toY: 0.04,
  vx: 2.3, vy: 0.7, radius: 0.14, strength: 0.8,
});
for (let i = 0; i < 17; i++) physics.step(1 / 120);

const sampler = new InteractionSampler(240);
const samples = [];
sampler.push(0, 0, 0);
sampler.push(0.3, 0.15, 10);
sampler.push(0.7, -0.2, 31);
sampler.drain(31, sample => samples.push({ ...sample }));

console.log(JSON.stringify({
  positions: [...physics.positions],
  velocities: [...physics.velocities],
  samples,
}, null, 2));
