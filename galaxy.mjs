import * as THREE from 'three';
import { GalaxyPhysics } from './physics.mjs';

const params = {
  count: 12000,
  radius: 6,
  insideColor: '#ff8a3d',
  outsideColor: '#3b4cff',
  speed: 1,
};

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 3.2, 6.0);
camera.lookAt(0, -0.3, 0);

// Background stars
function makeStars(n) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 30 + Math.random() * 30;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(p) * Math.cos(t);
    pos[i * 3 + 1] = r * Math.cos(p);
    pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 0.08, color: 0xbfd4ff, transparent: true, opacity: 0.7, depthWrite: false }));
}
scene.add(makeStars(1500));

// The shader only draws particles. Positions and velocities are integrated
// by the fixed-step gravitational simulation in physics.mjs.
const material = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uSize: { value: 54 * renderer.getPixelRatio() },
    uInside: { value: new THREE.Color(params.insideColor) },
    uOutside: { value: new THREE.Color(params.outsideColor) },
  },
  vertexShader: `
    uniform float uSize;
    uniform vec3 uInside;
    uniform vec3 uOutside;
    attribute float aScale;
    attribute float aVisibility;
    varying vec3 vColor;
    varying float vVisibility;
    void main() {
      vec4 vp = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * vp;
      gl_PointSize = clamp(uSize * aScale / max(0.1, -vp.z), 1.0, 24.0);
      vColor = mix(uInside, uOutside, clamp(length(position.xz) / 6.0, 0.0, 1.0));
      vVisibility = aVisibility;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    varying float vVisibility;
    void main() {
      float d = length(gl_PointCoord - 0.5) * 2.0;
      if (d > 1.0) discard;
      float glow = pow(1.0 - d, 2.5);
      gl_FragColor = vec4(vColor, glow * vVisibility * 0.8);
    }
  `,
});

let galaxy;
let physics;
function buildGalaxy() {
  if (galaxy) { galaxy.geometry.dispose(); scene.remove(galaxy); }
  physics = new GalaxyPhysics(params.count);
  const scales = new Float32Array(params.count);
  for (let i = 0; i < params.count; i++) {
    scales[i] = 0.45 + Math.random() * 0.85;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(physics.positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aVisibility', new THREE.BufferAttribute(physics.visibility, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  galaxy = new THREE.Points(geometry, material);
  // Simulation positions change; avoid a stale bounding sphere culling the disk.
  galaxy.frustumCulled = false;
  scene.add(galaxy);
}
buildGalaxy();

const holeElement = document.getElementById('black-hole');
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane();
const normal = new THREE.Vector3();
const target = new THREE.Vector3();
const origin = new THREE.Vector3();
const hole = { x: 0, y: 0, z: 0, strength: 0, radius: 1.8, captureRadius: 0.1 };
let pointerActive = false;
let pull = 0;

window.wallpaperPointerListener = ({ x, y, active }) => {
  pointerActive = Boolean(active) && Number.isFinite(x) && Number.isFinite(y)
    && x >= 0 && x <= 1 && y >= 0 && y <= 1;
  if (!pointerActive) return;
  pointer.set(x * 2 - 1, 1 - y * 2);
  holeElement.style.left = `${x * innerWidth}px`;
  holeElement.style.top = `${y * innerHeight}px`;
};
window.addEventListener('pointermove', event => {
  window.wallpaperPointerListener({ x: event.clientX / innerWidth, y: event.clientY / innerHeight,
    active: !event.target.closest('#controls') });
});
document.documentElement.addEventListener('pointerleave', () => { pointerActive = false; });
window.addEventListener('blur', () => { pointerActive = false; });

const quality = document.getElementById('quality');
function setQuality(value) {
  const light = value === 'light';
  quality.value = light ? 'light' : 'balanced';
  params.count = light ? 6000 : 12000;
  renderer.setPixelRatio(Math.min(devicePixelRatio, light ? 0.75 : 1));
  renderer.setSize(innerWidth, innerHeight);
  material.uniforms.uSize.value = 54 * renderer.getPixelRatio();
  buildGalaxy();
}
quality.addEventListener('change', () => {
  setQuality(quality.value);
  try { localStorage.setItem('galaxy-quality', quality.value); } catch {}
});
try {
  if (localStorage.getItem('galaxy-quality') === 'light') setQuality('light');
} catch {}

window.wallpaperPropertyListener = {
  applyGeneralProperties(properties) {
    const fps = Number(properties.fps);
    if (Number.isFinite(fps) && fps > 0) {
      interval = 1000 / Math.min(30, fps);
      previous = null;
      renderAt = 0;
      accumulator = 0;
    }
  },
  applyUserProperties(properties) {
    const speed = Number(properties.speed?.value);
    if (Number.isFinite(speed)) params.speed = Math.max(0, Math.min(2, speed));
    const count = Number(properties.count?.value);
    if (Number.isFinite(count)) {
      params.count = Math.round(Math.max(4, Math.min(quality.value === 'light' ? 6 : 24, count)) * 1000);
      buildGalaxy();
    }
  },
};
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  pointerActive = false;
});

// Bound both CPU and GPU work: 30 rendered frames/s, 120 Hz fixed physics,
// no catch-up backlog after a hidden tab or a slow frame.
const step = 1 / 120;
let interval = 1000 / 30;
let previous = null;
let renderAt = 0;
let accumulator = 0;
let simulationTime = 0;
let statsAt = 0;
let frames = 0;
let physicsMs = 0;
const stats = { fps: 0, physicsMs: 0, count: params.count, maxSteps: 0, simulationTime: 0 };
if (new URLSearchParams(location.search).has('debug')) window.__galaxyStats = stats;
const status = document.getElementById('status');
document.addEventListener('visibilitychange', () => {
  previous = null;
  accumulator = 0;
  if (document.hidden) { pointerActive = false; pull = 0; }
});
renderer.setAnimationLoop(now => {
  if (document.hidden) return;
  if (now < renderAt) return;
  const elapsed = previous === null ? 0 : Math.min((now - previous) / 1000, 1 / 15);
  previous = now;
  renderAt = now + interval - ((now - renderAt) % interval);
  pull += ((pointerActive ? 1 : 0) - pull) * (1 - Math.exp(-elapsed * 7));
  if (Math.abs((pointerActive ? 1 : 0) - pull) < 0.001) pull = pointerActive ? 1 : 0;
  holeElement.style.opacity = String(pull);
  camera.position.x = Math.sin(simulationTime * 0.03) * 0.8;
  camera.lookAt(0, -0.3, 0);
  camera.updateMatrixWorld();
  // Place a physical attractor on a camera-facing plane through the galaxy.
  // Unlike a ground-plane ray, this remains well-defined above the horizon.
  camera.getWorldDirection(normal);
  plane.setFromNormalAndCoplanarPoint(normal, origin);
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(plane, target)) {
    hole.x = target.x; hole.y = target.y; hole.z = target.z;
  }
  hole.strength = pull;
  // Match the visible 15 CSS-pixel horizon at the attractor's depth.
  const unitsPerPixel = 2 * camera.position.distanceTo(origin)
    * Math.tan(camera.fov * Math.PI / 360) / innerHeight;
  hole.captureRadius = 15 * unitsPerPixel;
  hole.radius = Math.min(240, Math.min(innerWidth, innerHeight) * 0.32) * unitsPerPixel;
  accumulator = Math.min(accumulator + elapsed * params.speed, step * 8);
  const started = performance.now();
  let steps = 0;
  while (accumulator >= step && steps < 8) {
    physics.step(step, hole);
    accumulator -= step;
    simulationTime += step;
    steps++;
  }
  physicsMs += performance.now() - started;
  stats.maxSteps = Math.max(stats.maxSteps, steps);
  if (steps) {
    galaxy.geometry.attributes.position.needsUpdate = true;
    galaxy.geometry.attributes.aVisibility.needsUpdate = true;
  }
  renderer.render(scene, camera);
  frames++;
  if (now - statsAt >= 1000) {
    stats.fps = Math.round(frames * 1000 / (now - statsAt));
    stats.physicsMs = physicsMs / frames;
    stats.count = params.count;
    stats.simulationTime = simulationTime;
    status.textContent = `${params.count.toLocaleString('vi-VN')} hạt · ${stats.fps} FPS`;
    frames = 0; physicsMs = 0; statsAt = now;
  }
});
