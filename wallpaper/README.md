# Đêm đầy sao · Tranh hạt

Saved wallpaper package. Open index.html through an HTTP server or a web wallpaper host (ES modules). Includes all assets locally; no internet required.

Preset: damping 0.2, return force 0.5, 96,000 particle budget, 240 Hz interaction, no application FPS cap. Actual count is rounded to the image grid. Hidden preview controls; centered image fits the screen. Saved wallpaper ignores browser settings so the preset remains reproducible. Hanabi pointer bridge: window.wallpaperPointerListener.

Editable preview: /home/mustang/MienCuong/space-galaxy-wallpaper/particle-painting.html

Particles use circular cores/halos with different sizes. Current-position block bounds and cached flow coefficients reduce cursor-force work while retaining 96k quality and 240 Hz sampling.

Each monitor runs its own independent particle simulation. Shared rendering is disabled. Split-renderer-process experiments were reverted because they froze/flickered on the physical displays.


## Backend desktop native (2026-10-05)

Desktop hiện dùng C++/OpenGL ES qua Hanabi, hai mô phỏng riêng, không đặt FPS cap, brightness 0.75. Hướng dẫn kiểm tra, khởi động lại và quay về Chromium: `/home/mustang/MienCuong/native-particle-wallpaper/README.md`. Bộ cài backend là cấu hình cục bộ riêng; ZIP tranh không tự cài backend. Bản HTML vẫn mở được qua HTTP để xem trước.
