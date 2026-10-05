import * as THREE from 'three';
import { PaintingPhysics } from './painting-physics.mjs';
import { InteractionSampler } from './interaction-sampler.mjs';

const wallpaperMode = document.body.dataset.wallpaper === 'true';
const message = document.getElementById('message');
const status = document.getElementById('status');
const quality = document.getElementById('quality');
const interactionRate = document.getElementById('interaction-rate');
try {
  const saved = wallpaperMode ? null : localStorage.getItem('painting-interaction-hz');
  if (['30', '60', '120', '240'].includes(saved)) interactionRate.value = saved;
} catch {}
const interactionSampler = new InteractionSampler(Number(interactionRate.value));
const dampingControl = document.getElementById('damping');
const springControl = document.getElementById('spring');
for (const control of [dampingControl, springControl]) {
  try {
    const saved = wallpaperMode ? null : localStorage.getItem(`painting-${control.id}`);
    const value = Number(saved);
    if (saved !== null && Number.isFinite(value) && value >= Number(control.min) && value <= Number(control.max)) control.value = value;
  } catch {}
  document.getElementById(`${control.id}-value`).value = Number(control.value).toFixed(1);
  control.addEventListener('input', () => {
    document.getElementById(`${control.id}-value`).value = Number(control.value).toFixed(1);
    physics?.setDynamics(Number(springControl.value), Number(dampingControl.value));
    try { localStorage.setItem(`painting-${control.id}`, control.value); } catch {}
  });
}
const pointerRing = document.getElementById('pointer-ring');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
renderer.setClearColor(0x070a11, 1);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, 0.1, 10);
camera.position.z = 3;
const material = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, depthWrite: false,
  // Premultiplied core + additive halo in one draw: the halo contributes RGB
  // without obscuring nearby grains. No bloom render targets or second pass.
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  uniforms: { uSize: { value: 4 }, uWaterTime: { value: 0 }, uHaloScale: { value: 2.2 }, uBrightness: { value: 0.75 } },
  vertexShader: `
    uniform float uSize;
    uniform float uWaterTime;
    uniform float uHaloScale;
    attribute float aSize;
    attribute vec3 aColor;
    attribute vec3 aHome;
    attribute vec3 aVelocity;
    varying vec3 vColor;
    varying float vDepth;
    varying float vFocus;
    varying float vEnergy;
    void main() {
      // Small travelling waves live on the GPU. Anchor their phase to each
      // home so a mouse stroke blends into the surface without phase jumps.
      float swell = sin(aHome.x * 6.0 + aHome.y * 4.0 - uWaterTime * 0.9);
      float crossWave = sin(-aHome.x * 3.0 + aHome.y * 7.0 + uWaterTime * 0.65);
      float ripple = sin(aHome.x * 11.0 - aHome.y * 5.0 - uWaterTime * 1.15);
      vec3 water = vec3(
        0.006 * swell + 0.003 * crossWave,
        0.005 * crossWave + 0.002 * ripple,
        0.012 * swell + 0.007 * crossWave
      );
      vec3 surfacePosition = position + water;
      vDepth = clamp(surfacePosition.z * 2.0, -0.3, 0.3);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(surfacePosition, 1.0);
      float speed = length(aVelocity.xy);
      vEnergy = smoothstep(0.015, 0.55, speed);
      vFocus = smoothstep(0.12, 0.78, dot(aColor, vec3(0.2126, 0.7152, 0.0722)));
      gl_PointSize = uSize * aSize * (1.0 + vDepth) * uHaloScale * (1.0 + 0.12 * vEnergy);
      vColor = aColor;
    }
  `,
  fragmentShader: `
    uniform float uBrightness;
    varying vec3 vColor;
    varying float vDepth;
    varying float vFocus;
    varying float vEnergy;
    void main() {
      vec2 point = (gl_PointCoord - 0.5) * 2.0;
      float radiusSq = dot(point, point);
      if (radiusSq >= 1.0) discard;
      float coreRadiusSq = radiusSq * 4.84;
      float coreAlpha = 1.0 - smoothstep(0.27, 1.0, coreRadiusSq);
      float hotSpot = max(0.0, 1.0 - coreRadiusSq);
      hotSpot = hotSpot * hotSpot * hotSpot;
      vec3 light = mix(vColor, vec3(1.0), (0.015 + 0.10 * vFocus + 0.32 * vEnergy) * hotSpot);
      float halo = 1.0 - radiusSq;
      halo = halo * halo * halo;
      // Quiet shadows, luminous stars, and a brief glint as moving paint settles.
      light *= 0.72 + 0.42 * vFocus + 0.65 * vEnergy;
      vec3 emission = vColor * halo * (0.018 + 0.28 * vFocus * vFocus + 1.10 * vEnergy);
      gl_FragColor = vec4((light * coreAlpha + emission) * (1.0 + vDepth * 0.35) * uBrightness, coreAlpha);
    }
  `,
});

let sourceImage;
let imageAspect = 1.263;
let physics;
let points;
let rows = 1;
let pixelsPerUnit = 1;
let accumulator = 0;
let previousFrame = null;
let loadGeneration = 0;
// Resample native and Hanabi input on a configurable timeline. This changes
// force sampling independently of display refresh and fixed physics steps.
let lastPointerX = NaN;
let lastPointerY = NaN;
let lastMotion = 0;
const stroke = { fromX: 0, fromY: 0, toX: 0, toY: 0, vx: 0, vy: 0, radius: 0.14, strength: 1 };

function clearInteraction() {
  interactionSampler.reset();
  lastPointerX = NaN;
  lastPointerY = NaN;
  pointerRing.style.opacity = '0';
}
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  const topSpace = wallpaperMode ? 0 : document.querySelector('header').getBoundingClientRect().bottom + 18;
  const bottomSpace = wallpaperMode ? 0 : innerHeight - document.querySelector('footer').getBoundingClientRect().top + 18;
  const availableHeight = Math.max(80, innerHeight - 2 * Math.max(topSpace, bottomSpace));
  const displayHeight = Math.min(availableHeight, Math.max(80, innerWidth - (wallpaperMode ? 0 : 72)) / imageAspect);
  pixelsPerUnit = displayHeight / 2;
  camera.left = -innerWidth / (2 * pixelsPerUnit);
  camera.right = -camera.left;
  camera.top = innerHeight / (2 * pixelsPerUnit);
  camera.bottom = -camera.top;
  camera.updateProjectionMatrix();
  material.uniforms.uSize.value = Math.max(1, displayHeight / rows * 1.25 * renderer.getPixelRatio());
  clearInteraction();
}

function buildPainting() {
  if (!sourceImage) return;
  const budget = quality.value === 'light' ? 12000 : quality.value === 'detail' ? 96000 : 48000;
  const columns = Math.max(1, Math.floor(Math.sqrt(budget * imageAspect)));
  rows = Math.max(1, Math.floor(budget / columns));
  const count = columns * rows;
  const sample = document.createElement('canvas');
  sample.width = columns; sample.height = rows;
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(sourceImage, 0, 0, columns, rows);
  const rgba = context.getImageData(0, 0, columns, rows).data;
  const homes = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizeClasses = new Uint8Array(count);
  const luminance = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const k = i * 4;
    luminance[i] = (rgba[k] * 0.2126 + rgba[k + 1] * 0.7152 + rgba[k + 2] * 0.0722) / 255 * (rgba[k + 3] / 255);
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x;
      const j = i * 3;
      // Deterministic mix: mostly medium grains, a few larger bright ones.
      // The same class drives both visible diameter and physical mass.
      const hash = Math.sin((i + 1) * 127.1) * 43758.5453;
      const sizePick = hash - Math.floor(hash);
      const brightness = luminance[i];
      sizeClasses[i] = Math.max(0, Math.min(4, Math.floor(brightness * 4.5 + sizePick * 1.6 - 0.35)));
      // Tiny deterministic jitter softens the sampling grid without losing
      // the original geometry or sampling a different color on every rebuild.
      const jitterX = Math.sin(i * 13.37) * 0.16;
      const jitterY = Math.sin(i * 7.91) * 0.16;
      homes[j] = ((x + 0.5 + jitterX) / columns - 0.5) * 2 * imageAspect;
      homes[j + 1] = (0.5 - (y + 0.5 + jitterY) / rows) * 2;
      const alpha = rgba[i * 4 + 3] / 255;
      colors[j] = rgba[i * 4] / 255 * alpha;
      colors[j + 1] = rgba[i * 4 + 1] / 255 * alpha;
      colors[j + 2] = rgba[i * 4 + 2] / 255 * alpha;
    }
  }
  physics = new PaintingPhysics(homes, sizeClasses);
  physics.setDynamics(Number(springControl.value), Number(dampingControl.value));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(physics.positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aHome', new THREE.BufferAttribute(physics.homes, 3));
  geometry.setAttribute('aVelocity', new THREE.BufferAttribute(physics.velocities, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(physics.sizes, 1));
  if (points) { scene.remove(points); points.geometry.dispose(); }
  points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  accumulator = 0;
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality.value === 'light' ? 0.8 : 1));
  resize();
  message.textContent = '';
}

async function loadImage(url, custom = false) {
  const generation = ++loadGeneration;
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    if (generation !== loadGeneration) return;
    if (image.naturalWidth * image.naturalHeight > 32000000) throw new Error('Ảnh quá lớn. Chọn ảnh dưới 32 megapixel.');
    const aspect = image.naturalWidth / image.naturalHeight;
    if (aspect < 0.2 || aspect > 5) throw new Error('Chọn ảnh có tỉ lệ cạnh từ 1:5 đến 5:1.');
    sourceImage = image;
    imageAspect = aspect;
    buildPainting();
    document.querySelector('h1').textContent = custom ? 'Bức tranh của bạn, từng hạt.' : 'Đêm đầy sao, từng hạt.';
    document.getElementById('caption').textContent = custom ? 'Màu từ ảnh gốc · Chuyển động theo tay bạn' : 'Vincent van Gogh · 1889';
  } catch (error) {
    if (generation === loadGeneration) message.textContent = error.message || 'Không đọc được ảnh. Hãy chọn ảnh khác.';
  }
}

function queuePointer(x, y, active, timestamp = performance.now()) {
  if (!physics || !active || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    clearInteraction(); return;
  }
  const worldX = (x * innerWidth - innerWidth / 2) / pixelsPerUnit;
  const worldY = (innerHeight / 2 - y * innerHeight) / pixelsPerUnit;
  pointerRing.style.left = `${x * innerWidth}px`;
  pointerRing.style.top = `${y * innerHeight}px`;
  interactionSampler.push(worldX, worldY, timestamp);
  if (worldX !== lastPointerX || worldY !== lastPointerY) {
    lastMotion = timestamp;
    pointerRing.style.opacity = '1';
  }
  lastPointerX = worldX;
  lastPointerY = worldY;
}
window.wallpaperPointerListener = ({ x, y, active }) => queuePointer(x, y, active);
renderer.domElement.addEventListener('pointermove', event => {
  const samples = event.getCoalescedEvents?.();
  if (samples?.length) {
    for (const sample of samples) {
      queuePointer(sample.clientX / innerWidth, sample.clientY / innerHeight, true, sample.timeStamp);
    }
  } else {
    queuePointer(event.clientX / innerWidth, event.clientY / innerHeight, true, event.timeStamp);
  }
});
renderer.domElement.addEventListener('pointerleave', clearInteraction);
window.addEventListener('blur', clearInteraction);
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  previousFrame = null; accumulator = 0; clearInteraction();
});
document.getElementById('reset').addEventListener('click', () => {
  if (!physics) return;
  physics.reset(); clearInteraction();
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.aVelocity.needsUpdate = true;
});
quality.addEventListener('change', buildPainting);
interactionRate.addEventListener('change', () => {
  interactionSampler.setRate(Number(interactionRate.value));
  clearInteraction();
  try { localStorage.setItem('painting-interaction-hz', interactionRate.value); } catch {}
});
document.getElementById('image-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) { message.textContent = 'Chọn ảnh nhỏ hơn 12 MB để giữ máy nhẹ.'; return; }
  const url = URL.createObjectURL(file);
  try { await loadImage(url, true); } finally { URL.revokeObjectURL(url); event.target.value = ''; }
});

const stats = { fps: 0, count: 0, physicsMs: 0, maxDisplacement: 0, maxSteps: 0 };
if (new URLSearchParams(location.search).has('debug')) {
  window.__paintingStats = stats;
  window.__paintingSample = index => ({
    size: physics.sizes[index],
    mass: physics.masses[index],
    color: Array.from(points.geometry.attributes.aColor.array.subarray(index * 3, index * 3 + 3)),
    velocity: Array.from(physics.velocities.subarray(index * 3, index * 3 + 3)),
    home: Array.from(physics.homes.subarray(index * 3, index * 3 + 3)),
    position: Array.from(physics.positions.subarray(index * 3, index * 3 + 3)),
  });
}
let statsAt = performance.now();
let frames = 0;
let physicsMs = 0;
let interactionSamples = 0;
let wallpaperPaused = Boolean(window.__hanabiPaused);
window.__hanabiSetPaused = paused => {
  wallpaperPaused = Boolean(paused);
  previousFrame = null; accumulator = 0; clearInteraction();
  stats.fps = 0;
  statsAt = performance.now(); frames = 0; physicsMs = 0; interactionSamples = 0;
};
const applyInteraction = sample => {
  stroke.fromX = sample.fromX; stroke.fromY = sample.fromY;
  stroke.toX = sample.toX; stroke.toY = sample.toY;
  stroke.vx = sample.vx; stroke.vy = sample.vy;
  stroke.radius = Math.max(0.12, Math.min(0.34, 65 / pixelsPerUnit));
  physics.disturb(stroke);
  interactionSamples++;
};
renderer.setAnimationLoop(now => {
  if (document.hidden || wallpaperPaused) return;
  const elapsed = previousFrame === null ? 0 : Math.min((now - previousFrame) / 1000, 1 / 15);
  previousFrame = now;
  material.uniforms.uWaterTime.value += elapsed;
  if (physics) {
    const started = performance.now();
    interactionSampler.drain(now, applyInteraction, 32);
    accumulator = Math.min(accumulator + elapsed, 8 / 120);
    let steps = 0;
    while (accumulator >= 1 / 120 && steps < 8) {
      physics.step(1 / 120);
      accumulator -= 1 / 120;
      steps++;
    }
    stats.maxSteps = Math.max(stats.maxSteps, steps);
    if (steps) {
      points.geometry.attributes.position.needsUpdate = true;
      points.geometry.attributes.aVelocity.needsUpdate = true;
    }
    physicsMs += performance.now() - started;
  }
  if (now - lastMotion > 200) pointerRing.style.opacity = '0';
  renderer.render(scene, camera);
  frames++;
  stats.framesRendered = (stats.framesRendered || 0) + 1;
  if (now - statsAt >= 1000) {
    stats.fps = Math.round(frames * 1000 / (now - statsAt));
    stats.physicsMs = physicsMs / frames;
    stats.count = physics ? physics.positions.length / 3 : 0;
    stats.interactionHz = Number(interactionRate.value);
    stats.interactionSamplesPerSecond = Math.round(interactionSamples * 1000 / (now - statsAt));
    interactionSamples = 0;
    if (physics && window.__paintingStats) {
      let max = 0;
      for (let i = 0; i < physics.positions.length; i += 3) {
        const dx = physics.positions[i] - physics.homes[i];
        const dy = physics.positions[i + 1] - physics.homes[i + 1];
        max = Math.max(max, dx * dx + dy * dy);
      }
      stats.maxDisplacement = Math.sqrt(max);
    }
    status.textContent = `${stats.count.toLocaleString('vi-VN')} hạt · ${stats.fps} FPS`;
    statsAt = now; frames = 0; physicsMs = 0;
  }
});
resize();
loadImage('./assets/starry-night.jpg');
