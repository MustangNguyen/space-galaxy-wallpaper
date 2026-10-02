# Space Galaxy Wallpaper

Animated spiral particle galaxy built with Three.js, packaged as a Wallpaper Engine `web` wallpaper.
Intended to run on Linux via [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine).

## Files

- `index.html` — the wallpaper (Three.js loaded from jsDelivr CDN)
- `project.json` — Wallpaper Engine manifest with user properties (rotation speed, particle count)

## Run

Preview in a browser (ES modules need HTTP, not `file://`):

```bash
python3 -m http.server 8765
```

Windowed test with linux-wallpaperengine:

```bash
linux-wallpaperengine --window 0x0x1920x1080 .
```

As desktop background (X11 session; GNOME Wayland does not support wlr-layer-shell):

```bash
linux-wallpaperengine --screen-root <output-name> .
```
