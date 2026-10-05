# Desktop measurements — 2026-10-02

RTX 3050, two 1920×1080 displays at 99.65 Hz, WebKitGTK 2.52.6. All measurements are short runtime samples, not guaranteed FPS.

- Two independent WebViews: about 33 FPS.
- No physics/uploads: about 36 FPS.
- No render submission: about 62 callbacks/sec (not displayed FPS).
- Render empty scene: about 34 FPS.
- One shared WebView mirrored with Gtk.WidgetPaintable: about 40–53 FPS, including pointer interaction samples.

Retained only opt-in shared WebView optimization. Reverted Cairo/Vulkan, forced DMA-BUF, VSync and refresh-preference experiments; no repeatable gain justified retaining them. 96k budget, 240 Hz sampling, circular particles, original resolution and uncapped rendering are preserved. Not yet 100 FPS.

Renderer source: /home/mustang/MienCuong/gnome-ext-hanabi/src/renderer/renderer.ts. Renderer lint, TypeScript check and build passed. Runtime logged 95,700 particles and received interaction. Visual confirmation on both physical displays remains user-verifiable.

## Current status

Shared rendering was disabled at the user’s request. Separate renderer processes yielded higher counters but caused visible freezing/flicker reported by the user, so that experiment was reverted. The active configuration uses two independent WebViews in the original single Hanabi renderer process. 100 FPS has not been achieved.


## Chromium desktop — 2026-10-02

Backend hiện tại là Chromium qua socket Wayland của Hanabi, hai trang/mô phỏng riêng ở 1920×1080. Giữ nguyên 95.700 hạt/màn và preset. Mẫu đo desktop sau khi cài và khởi động lại: khoảng 99–100 lần render/giây trên cả hai màn; người dùng xác nhận nền đúng lớp và mượt. Pause/resume đã kiểm tra qua D-Bus, 26 kiểm thử vật lý/lấy mẫu chuột đều qua. Không coi bộ đếm render là phép đo độc lập khung hình vật lý. Chi tiết và số liệu: `/home/mustang/MienCuong/chromium-wallpaper/desktop-validation.json`.
