# Native particle wallpaper: implementation decision

Date: 2026-10-05. Status: native renderer implemented, built, and activated on this desktop. The sections below preserve the original design and proof gates; see README.md and research/native-desktop-validation.json for actual results.

Implementation differences: a small GJS bridge retains D-Bus/settings and forwards the compositor-owned socket to one C++ process. Each monitor has its own render thread/context and physics state, with a shared Wayland control dispatcher. The fixed current preset uses a 96,000 particle budget and 240 Hz interpolation. Presentation feedback and frame-time percentiles are not implemented; reported FPS counts submitted frames. Login, suspend, hotplug, fractional scaling, and visual desktop confirmation remain separate validation items.

## Decision

Implement a small Linux-specific C++17 host using system libwayland-client, libwayland-egl, EGL, OpenGL ES 3, and GLib/GIO. Keep Hanabi's existing desktop attachment and normalized-pointer bridge. Replace Chromium, its Node HTTP/SSE supervisor, and their separate GJS bridge with a native application that implements the same D-Bus contract. A tiny existing GJS launcher may remain solely to forward the compositor-owned socket to the executable and supervise exit; measure its contribution separately if retained.

Use NeoWall as an architecture reference, not a wholesale fork: its layer-shell backend does not support GNOME and its shader-centric content model does not provide this particle simulation. No third-party code has been copied into the probe; painting shader formulas come from the existing local wallpaper.

GLFW remains a possible window-management alternative if a direct Wayland host proves costly, but its development package is not available here. Do not install it as an unreviewed assumption. Direct EGL avoids adding a library but requires explicitly implementing xdg-shell configure/ping/close/output/frame handling; this is a real maintenance tradeoff.

## Fresh local evidence

- EGL pkg-config: 1.5; wayland-client: 1.24.0; wayland-egl: 18.1.0; GIO: 2.88.0; GLES: 3.2; gdk-pixbuf: 2.44.5.
- C++ compiler, CMake, wayland-scanner and relevant EGL/GLES/Wayland headers present.
- GLFW/GLEW/SDL2 development packages were not found through pkg-config.
- `wayland-protocols.pc` and xdg-shell XML were not found in the inspected system/project paths. Before building windows, obtain a pinned upstream xdg-shell XML and generate bindings with the installed scanner; preserve its copyright/license. A protocol XML is required even though the client libraries are already installed.
- `research/gpu-probe.cpp` opened a separate Wayland connection, created an EGL surfaceless OpenGL ES context and reported NVIDIA RTX 3050 / driver 595.91.07 / GLES 3.2.
- Existing painting vertex and fragment shader bodies, mechanically adapted to GLSL ES 300 declarations, compiled and linked successfully. Point-size support: 1–2047 pixels.
- This proves context and shader compatibility only. No desktop window, image parity, two-output scheduling, PSS saving or displayed FPS has yet been proven.

Reproduce the probe:

```bash
cd /home/mustang/MienCuong/native-particle-wallpaper
c++ -std=c++17 -O2 -Wall -Wextra research/gpu-probe.cpp -o research/gpu-probe $(pkg-config --cflags --libs egl glesv2 wayland-client)
./research/gpu-probe research/painting.vert research/painting.frag
```

## Behavior to preserve

- Starry Night source image, grid/jitter and brightness-biased size distribution.
- 95,700 actual particles per screen, from a 96,000 budget.
- Five sizes 0.65, 0.85, 1, 1.25, 1.55, mass = size squared.
- Spring 0.5; damping 0.2; exact spring solver with the same speed/displacement clamps.
- Physics at 120 Hz with bounded catch-up; cursor resampling at 240 Hz with the same stale/endpoint behavior.
- Existing Shell pointer delivery is every 33 ms: 240 Hz is interpolation, not raw 240 Hz cursor acquisition. Preserve this initially for a fair comparison.
- Current-position block bounds (128 particles), cached flow and allocation-free hot loops.
- Circular point sprites, depth/water motion, velocity-dependent glow, premultiplied core plus additive halo in one draw; brightness 0.75.
- No application FPS cap. Synchronization with the display/compositor is distinct from a software cap. No busy-loop rendering thousands of invisible frames just to report a higher FPS.
- Two independent particle states and interaction histories. Shared immutable image/shader resources are allowed; sharing the moving simulation is not.

## Native integration contract

1. Hanabi launches through Meta.WaylandClient. Inherit WAYLAND_SOCKET without closing or reconnecting it to the ordinary display; one owning Wayland connection creates both xdg-toplevel surfaces.
2. Each surface has Hanabi's exact renderer title/state and monitor location. Do not assume Wayland accepts client-side absolute window positioning: Hanabi's Mutter-side placement remains authoritative.
3. Use matching app identity, no titlebar/translation UI and no focus theft. Test minimized-and-cloned surfaces explicitly, because a visible-window benchmark does not establish wallpaper performance.
4. Expose `io.github.jeffshee.HanabiRenderer` at `/io/github/jeffshee/HanabiRenderer`, implementing `setPointer(int,double,double,bool)`, `setPlay()`, `setPause()`, `isPlaying`, and `isPlayingChanged(bool)`.
5. GIO handles D-Bus/settings on the control thread. Each monitor owns a rendering context/thread and Wayland event queue; it receives cursor/pause state through a bounded mailbox. Do not serialize two blocking eglSwapBuffers calls on one thread: that could halve effective frame rate. Follow Wayland queue/read/dispatch rules carefully; shutdown wakes blocked workers before joining them.
6. Separate dynamic position/velocity buffers for each screen. Static image/home/color buffers may be shared between contexts if synchronization is explicit.
7. On monitor changes, validate connector, logical geometry, transform, scale and Shell pointer index mapping. Never equate enumeration order with monitor identity without verification. Recreate cleanly or fall back to the working backend.
8. Pause clears input backlog and time accumulator. Resume does not simulate the entire time spent paused. SIGTERM releases workers, GL resources, surfaces and D-Bus name; no child browser processes exist.

## Work order and proof gates

### 1. Prove the desktop transport first

Create a minimal native two-surface animated color/grid renderer before porting all particles. Run a normal preview, then a bounded Hanabi test with rollback. Verify ownership, full monitor geometry, absence from Alt-Tab/Overview, no click interception, and continuing frame production while minimized/cloned. Test each screen independently. If this fails, solve transport before investing in physics.

### 2. Port and compare the effect

Separate `physics`, `interaction`, `painting data`, `GL renderer` and `Wayland/GIO host`. Keep CPU spring physics first: historical ~1–3 ms/frame does not justify moving all physics into compute shaders before measurement. Convert existing JS test scenarios into deterministic fixtures; compare native arrays after matching strokes/timesteps with documented float tolerances. Cover critical/overdamping, size/mass differences, sparse pointer sampling, reset, NaNs and bounds culling.

Image sampling must be compared: Canvas drawImage interpolation/color handling may differ from GdkPixbuf. Match the resulting particle colors/distribution visually and with sampled data; do not assume the same JPEG automatically produces identical particles.

### 3. Measure the same workload

Run Chromium and native in turn, not simultaneously for the comparison. Measure two 1920x1080 outputs, 95,700 particles each, idle/mouse/settling, after warmup. Record PSS for each whole process group (RSS separately), per-screen submitted-frame counts, wall-clock intervals and frame-time tails. Use Wayland presentation feedback where supported, keeping submitted FPS distinct from presented frames.

Proposed acceptance target (not measured result): stable rendering near the current ~99–100 FPS on both 99.65-Hz outputs; investigate averages below 95 FPS or long stalls. Aim for at least 50% lower total PSS than a fresh same-session Chromium baseline. Historical Chromium PSS ~620 MiB is context only; remeasure it. Report driver memory and shared mappings caveats rather than promising a fixed MB number.

### 4. Activate only the verified build

Use a project backend selector with explicit native/chromium restore paths, retaining the current wallpaper assets/preset and working Chromium install. Verify start/stop/restart, pause/resume, display changes, mouse confinement to its screen and persisted autostart configuration. Login/suspend recovery must be marked unverified until actually observed; do not log the user out to manufacture a test.

## Sources

- NeoWall architecture: https://raw.githubusercontent.com/1ay1/neowall/main/docs/ARCHITECTURE.md
- GLFW Wayland requirements: https://www.glfw.org/docs/latest/compat_guide.html
- Wayland connection ownership and event queues: https://wayland.freedesktop.org/docs/html/apb.html
- xdg-shell upstream protocol: https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/stable/xdg-shell/xdg-shell.xml (web endpoint returned anti-bot page during this research; obtain source through an official accessible repository endpoint before generation).
- Native D-Bus object registration: https://docs.gtk.org/gio/method.DBusConnection.register_object.html
- Earlier candidate review: ../chromium-wallpaper/NATIVE-RESEARCH.md
