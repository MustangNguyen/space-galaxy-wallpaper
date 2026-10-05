# Hanabi integration

Patch against https://github.com/MustangNguyen/gnome-ext-hanabi, branch `web-wallpaper`, commit `40034709ed4a10b376cbffac7bbc4b91d08d7d07`. It adds per-monitor desktop pointer forwarding and corrects the GNOME window tracker override. Hanabi is GPL-3.0-or-later; this patch modifies that component.

Apply inside that checkout: `git apply --check /path/to/this-repo/integration/hanabi.patch`, then `git apply /path/to/this-repo/integration/hanabi.patch`. Build/install following that repository's instructions. No patch is applied automatically by the native manager.

The manager requires this customized Hanabi installation. Its Chromium rollback also requires the previously installed Chromium backend; this repository does not bundle that backend.
