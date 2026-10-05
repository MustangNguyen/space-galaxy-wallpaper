# Native particle wallpaper

Bản native C++17/OpenGL ES 3 thay Chromium để vẽ tranh hạt trên GNOME Wayland qua Hanabi. Đã kích hoạt trên máy này ngày 2026-10-05; không cần logout.

Hai màn hình có mô phỏng riêng, mỗi màn 95.700 hạt. Giữ hạt tròn, kích thước/khối lượng khác nhau, dao động mặt nước, phát sáng theo vận tốc, damping 0.2, spring 0.5 và brightness 0.75. Vật lý chạy 120 Hz; tương tác nội suy 240 Hz từ dữ liệu chuột Shell khoảng 30 Hz. Không đặt FPS cap ứng dụng; compositor điều phối khung hình.

## Sử dụng

```bash
cd /path/to/space-galaxy-wallpaper
python3 manage.py status   # FPS, số hạt, tương tác từng màn
python3 manage.py restart  # Khởi động lại native
python3 manage.py restore  # Quay về Chromium đã cài trước đó
python3 manage.py install  # Cài/kích hoạt lại native
```

Trình quản lý dừng backend cũ trước khi bật backend mới. Cài đặt hiện dành cho cấu hình hai màn của máy này; kiểm tra khởi động chờ cả hai màn có ít nhất 150 khung hình và FPS > 30, tự chọn lại Chromium nếu kiểm tra thất bại. Kiểm tra này chỉ xác nhận khởi động, không chứng minh độ mượt hay vị trí cửa sổ.

Preset và tranh: `/home/mustang/MienCuong/starry-night-particle-wallpaper/`. Backend được lưu trong `project.json` với `hanabi.renderer = native`. Hanabi đã bật sẽ dùng lựa chọn này trong lần đăng nhập tiếp theo, nhưng chưa kiểm thử đăng nhập lại/suspend/hotplug.

## Build và kiểm tra

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j2
ctest --test-dir build --output-on-failure
python3 manage.py install
```

Dùng các thư viện hệ thống sẵn có: EGL, GLES3, wayland-client, wayland-egl, gdk-pixbuf, cùng CMake, C++17, pkg-config, wayland-scanner. Header nlohmann/json lấy từ checkout bên cạnh `linux-wallpaperengine/src/External/json/include`; cần đường dẫn đó khi build. Không cần Node, HTTP server hoặc trình duyệt cho backend native. GJS nhỏ vẫn giữ giao tiếp D-Bus với Hanabi và chuyển socket Wayland cho app.

`protocol/xdg-shell.xml` lấy từ upstream Wayland protocols 1.45; thông báo bản quyền/giấy phép được giữ trong file. Shader và thuật toán vật lý chuyển từ tranh web hiện có. Không sao chép mã NeoWall.

## Kết quả kiểm tra

- Release build và CTest đạt. Fixture vật lý khớp JavaScript trong sai số 2e-7, sampler trong 1e-12; kiểm thử sanitizer cũng đạt.
- Tạm dừng qua D-Bus dừng bộ đếm khung hình cả hai màn; chạy tiếp làm cả hai tăng trở lại.
- RAM PSS native + GJS khoảng 105 MiB ở lần đo đầu. Đây là RAM được chia phần theo mapping dùng chung, không phải tổng RSS hoặc VRAM. Chromium trước chuyển đổi đo khoảng 284 MiB riêng các tiến trình Chrome; khác tuổi tiến trình, không dùng để khẳng định tỷ lệ tiết kiệm chính xác.
- Khởi động lại đạt: còn đúng native + GJS, không còn tiến trình Chromium làm nền; tổng PSS sau khởi động lại khoảng 100 MiB. Mẫu 12 giây sau khởi động lại trung bình 97.96 và 97.88 FPS; mẫu 20 giây trước đó trung bình 92.11 và 94.46 FPS, có cửa sổ đo xuống 85.47 FPS. Chưa thể khẳng định giữ 100 FPS ổn định dưới mọi tải.
- FPS từng màn và mẫu đo được lưu tại `research/native-desktop-validation.json` và `research/restart-validation.json`. Đây là tốc độ gửi khung hình, không phải đo số khung hình thực sự được màn hình trình bày. Hai màn hiện khoảng 99.65 Hz.
- Ảnh preview native đã kiểm tra; độ giống màu tuyệt đối với Canvas không được đảm bảo do thuật toán lấy mẫu ảnh khác nhau. Xác nhận trực quan desktop/tương tác từ người dùng vẫn cần theo dõi.

Log: `journalctl --user -b --since "5 minutes ago"` và `/run/user/1000/hanabi-native-metrics.json`. Shell đang tải có thể còn cảnh báo `create_icon_texture` từ override Hanabi cũ khi tạo cửa sổ; không được tính là log hoàn toàn sạch. Chưa kiểm thử layout khác, fractional scaling, suspend hay đăng nhập lại.

## Bố cục repo và phục hồi

Repo này thay bản galaxy/web trước đây bằng app native. Bản web cũ vẫn ở lịch sử Git (commit `59ee847`). `wallpaper/` giữ toàn bộ tranh, preset và bản web tương ứng làm bản sao phục hồi. `integration/hanabi.patch` giữ thay đổi Hanabi cần cho tương tác chuột và hai màn. `build/`, binary, cache và log cục bộ không được đưa lên Git.

`manage.py` là công cụ triển khai dành cho máy hiện tại, yêu cầu Hanabi tùy chỉnh đã cài và thư mục `starry-night-particle-wallpaper` nằm cạnh checkout. Khi khôi phục ở vị trí mới, chép `wallpaper/` thành thư mục đó và chọn đường dẫn ấy trong Hanabi trước khi cài backend. Không ghi đè thư mục tranh đang có mà chưa sao lưu. CMake tìm header `nlohmann/json.hpp` từ hệ thống hoặc checkout `linux-wallpaperengine` bên cạnh; có thể chỉ định `-DNLOHMANN_JSON_INCLUDE_DIR=/path/to/include`.

Bản native đã được người dùng xác nhận chạy mượt trên desktop hai màn. Các giới hạn kiểm thử khác nêu trên vẫn áp dụng.
