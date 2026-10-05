import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GLibUnix from "gi://GLibUnix";
import System from "system";

const ID = "io.github.jeffshee.HanabiRenderer";
const OBJECT = "/io/github/jeffshee/HanabiRenderer";
const fileIndex = ARGV.indexOf("-F");
if (fileIndex < 0 || !ARGV[fileIndex + 1])
  throw new Error("Wallpaper directory is required");
const root = ARGV[fileIndex + 1];
const runtime = Gio.File.new_for_uri(import.meta.url)
  .get_parent()
  .get_child("particle-wallpaper")
  .get_path();
const reply = Gio.DBus.session
  .call_sync(
    "org.gnome.Mutter.DisplayConfig",
    "/org/gnome/Mutter/DisplayConfig",
    "org.gnome.Mutter.DisplayConfig",
    "GetCurrentState",
    null,
    null,
    Gio.DBusCallFlags.NONE,
    5000,
    null,
  )
  .deep_unpack();
const monitors = reply[2].map((logical, index) => {
  const physical = reply[1].find((m) => m[0][0] === logical[5][0][0]);
  const mode = physical?.[1].find((m) => m[6]["is-current"]?.deep_unpack());
  if (!mode) throw new Error("No current mode for monitor " + index);
  const rotated = [1, 3, 5, 7].includes(logical[3]);
  return {
    index,
    x: logical[0],
    y: logical[1],
    width: Math.round(mode[rotated ? 2 : 1] / logical[2]),
    height: Math.round(mode[rotated ? 1 : 2] / logical[2]),
  };
});
const socketValue = GLib.getenv("WAYLAND_SOCKET");
const socket = Number(socketValue);
if (socketValue === null || !Number.isInteger(socket) || socket < 3)
  throw new Error("Missing compositor-owned Wayland socket");
const launcher = new Gio.SubprocessLauncher({
  flags: Gio.SubprocessFlags.STDIN_PIPE,
});
launcher.take_fd(socket, 3);
launcher.setenv("WAYLAND_SOCKET", "3", true);
const child = launcher.spawnv([runtime, root, JSON.stringify(monitors)]);
launcher.close();
const input = child.get_stdin_pipe();
const loop = new GLib.MainLoop(null, false);
let quitting = false;
let shutdownTimeout = 0;
function stop() {
  if (quitting) return;
  quitting = true;
  // Signal the supervisor so it can reap the renderer before this bridge exits.
  // Closing stdin while an async pointer write is pending can fail with PENDING.
  child.send_signal(15);
  shutdownTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
    child.force_exit();
    loop.quit();
    return GLib.SOURCE_REMOVE;
  });
}
let writePending = false;
let pendingPointer = null;
let pendingPause = null;
function flush() {
  if (quitting || writePending) return;
  const data = pendingPause || pendingPointer;
  if (!data) return;
  if (pendingPause) pendingPause = null;
  else pendingPointer = null;
  writePending = true;
  input.write_all_async(
    new TextEncoder().encode(JSON.stringify(data) + "\n"),
    GLib.PRIORITY_DEFAULT,
    null,
    (stream, result) => {
      writePending = false;
      try {
        stream.write_all_finish(result);
        flush();
      } catch (error) {
        if (!quitting) {
          console.error(error);
          stop();
        }
      }
    },
  );
}
function send(data) {
  if (data.type === "pause") pendingPause = data;
  else pendingPointer = data;
  flush();
}
const api = {
  isPlaying: true,
  setPointer(monitor, x, y, active) {
    send({ type: "pointer", monitor, x, y, active });
  },
  setPlay() {
    this.setPlaying(true);
  },
  setPause() {
    this.setPlaying(false);
  },
  setPlaying(playing) {
    if (this.isPlaying === playing) return;
    this.isPlaying = playing;
    send({ type: "pause", paused: !playing });
    exported.emit_signal(
      "isPlayingChanged",
      new GLib.Variant("(b)", [playing]),
    );
    exported.emit_property_changed("isPlaying", new GLib.Variant("b", playing));
  },
};
const xml = `<node><interface name="${ID}"><method name="setPointer"><arg type="i" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="b" direction="in"/></method><method name="setPlay"/><method name="setPause"/><property name="isPlaying" type="b" access="read"/><signal name="isPlayingChanged"><arg type="b"/></signal></interface></node>`;
const exported = Gio.DBusExportedObject.wrapJSObject(xml, api);
exported.export(Gio.DBus.session, OBJECT);
const name = Gio.bus_own_name_on_connection(
  Gio.DBus.session,
  ID,
  Gio.BusNameOwnerFlags.NONE,
  null,
  null,
);
const settings = new Gio.Settings({
  schema_id: "io.github.jeffshee.hanabi-extension",
});
settings.connect("changed::video-path", stop);
const displaySignal = Gio.DBus.session.signal_subscribe(
  "org.gnome.Mutter.DisplayConfig",
  "org.gnome.Mutter.DisplayConfig",
  "MonitorsChanged",
  "/org/gnome/Mutter/DisplayConfig",
  null,
  Gio.DBusSignalFlags.NONE,
  stop,
);
for (const signal of [2, 15])
  GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal, () => {
    stop();
    return GLib.SOURCE_REMOVE;
  });
child.wait_async(null, (process, result) => {
  process.wait_finish(result);
  loop.quit();
});
console.log("Native bridge started", JSON.stringify(monitors));
loop.run();
if (shutdownTimeout) GLib.source_remove(shutdownTimeout);
exported.unexport();
Gio.bus_unown_name(name);
Gio.DBus.session.signal_unsubscribe(displaySignal);
System.exit(0);
