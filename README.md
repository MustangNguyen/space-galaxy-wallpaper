# Space Galaxy Wallpaper

Animated spiral particle galaxy built with Three.js, packaged as a Wallpaper Engine `web` wallpaper.
Intended to run on Linux via [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine).

## Files

- `index.html` — the wallpaper
- `vendor/three.module.min.js` — Three.js r169, bundled so the wallpaper works offline (MIT, see `vendor/THREE-LICENSE`)
- `project.json` — Wallpaper Engine manifest with user properties (rotation speed, particle count)

## Run

Preview in a browser (ES modules need HTTP, not `file://`):

```bash
python3 -m http.server 8765
```

The current local preview is served on `http://127.0.0.1:8765/` by the temporary user service `galaxy-preview`. Stop it with `systemctl --user stop galaxy-preview`. It is not enabled for login startup.

Windowed test with linux-wallpaperengine:

```bash
linux-wallpaperengine --window 0x0x1920x1080 .
```

As desktop background (X11 session; GNOME Wayland does not support wlr-layer-shell):

```bash
linux-wallpaperengine --screen-root <output-name> .
```

## Gravity and mouse interaction

Each galaxy particle has position and velocity integrated at a fixed 120 Hz. A softened, fixed galactic potential holds the disk in orbit; the mouse adds a local softened gravitational attractor. Particles retain momentum when the pointer moves away. Capture and recycling keep the wallpaper populated. This is a test-particle simulation with an artistic capture/replenishment model, not an N-body or relativistic simulation; particles do not attract one another.

Rendering is capped at 30 FPS, with 12,000 particles by default and device pixel ratio capped at 1. The preview's **Nhẹ** preset uses 6,000 particles and 0.75 pixel ratio; **Cân bằng** uses 12,000. The choice is saved locally. Work per physics step is O(N), using reusable typed arrays and no per-particle temporary objects. Hidden tabs pause; catch-up work is capped to avoid overload after a stall. Wallpaper Engine's lower global FPS limit is honored, and hosted particle-count changes cannot raise the light preset above 6,000. Slow devices may run below 30 FPS; simulation time slows if the eight-step work budget is exhausted.

Move the pointer to attract nearby particles. Browser previews use pointer events; the local Hanabi build forwards normalized desktop coordinates through `window.wallpaperPointerListener({x, y, active})`. The desktop system cursor remains available for normal interaction. Setting simulation speed to zero pauses physics.

## Verification

Run `node --test physics.test.mjs` for orbital stability, attraction, inertia, capture and finite-state checks. Open the preview with `?debug=1` to inspect `window.__galaxyStats` (rendered FPS, average physics milliseconds per rendered frame, particle count and maximum substeps).

## Separate particle painting

Open `http://127.0.0.1:8765/particle-painting.html` for the independent painting demo. The galaxy entry point is unchanged. This page samples the bundled *The Starry Night* into about 48,000 colored particles by default (12,000 in the light preset; 96,000 in the detail preset). Each particle has a fixed home and an underdamped spring; cursor strokes carry particles through smooth, spatially coherent curls along the entire swept path, with a little depth motion, and the particles settle back after movement stops. The continuous flow avoids a hard radial split along the brush center. Resting particles skip oscillator arithmetic. Particles have five stable diameter classes (0.65–1.55×), shared by rendering and physics. Mass scales with diameter squared for equal-density discs: identical cursor impulses produce smaller velocity changes in heavier grains. The base damping is 2.3, allowing longer gliding and slower settling. The spring force stays constant while damping scales with the square root of mass, so large grains oscillate more slowly. Five cached oscillator coefficient sets avoid per-particle trigonometry. Bright cores and soft colored halos are composited in a single particle draw, without bloom buffers. Three low-amplitude travelling waves in the vertex shader keep the painting gently moving like water even without pointer input. Wave phases are anchored to particle homes; mouse spring motion is layered on top. The reset button clears pointer disturbances while the ambient surface keeps moving. Debug `maxDisplacement` measures spring displacement, not the shader-only ambient waves. **Rendering has no application FPS cap** and follows browser/display refresh. Physics uses a fixed 120 Hz step with bounded catch-up work, typed arrays, and no particle-pair interactions.

Use **Đổi tranh** to sample a local PNG, JPEG or WebP; images stay local and are not uploaded. **Về chỗ cũ** resets the composition. This demo also accepts Hanabi's `wallpaperPointerListener` input, but is not selected as the desktop wallpaper automatically.

Files: `particle-painting.html`, `particle-painting.mjs`, `painting-physics.mjs`, and `assets/starry-night.jpg`. Artwork source and public-domain attribution are in `assets/ARTWORK.md`. Run `node --test painting-physics.test.mjs` to verify swept input, spring oscillation, settling, limits and reset. Add `?debug=1` to the URL for `window.__paintingStats`.

### Interaction frequency

The painting preview's **Tương tác** selector offers 30, 60, 120 and 240 Hz (default 120 Hz), saved in local storage. `InteractionSampler` interpolates timestamped native/coalesced or Hanabi pointer positions into evenly timed force samples. Higher rates make fast strokes more continuous at a higher CPU cost; rendering remains uncapped and visible smoothness still depends on actual FPS. Work is bounded to 32 force samples per rendered frame; input older than 200 ms is discarded. Changing the rate, leaving the canvas, hiding the page or rebuilding the painting clears the pending stroke.

Run `node --test interaction-sampler.test.mjs` to verify rate changes, sparse input interpolation, stationary samples, short strokes, pause/reset and work limits. Debug stats include `interactionHz` and `interactionSamplesPerSecond` (non-stationary samples actually applied).

### Round particles and lighting

All particles now use circular cores and radial halos. Image luminance biases the five size/mass classes and controls glow; velocity adds highlights while moving. Rendering uses a single particle draw with no bloom targets and no application FPS cap. Cursor forces skip spatially distant 128-particle blocks using current-position bounds, reused across samples until the next physics step. Home-dependent flow coefficients are precomputed once. A 96k-particle, 240 Hz stroke benchmark improved from 402 ms to 255 ms over the same simulated sequence (1.58x CPU speedup, not a desktop FPS claim). Regression tests compare block culling with a full scan.

The painting has live **Lực cản** (0.2–6, default 2.3) and **Lực hồi về** (0.5–20, default 6) sliders. Lower return force slows the return; lower drag retains momentum longer. Both persist locally and survive quality/image changes without resetting particles when adjusted. The solver handles underdamped, critically damped and overdamped combinations. Rendering remains uncapped.
