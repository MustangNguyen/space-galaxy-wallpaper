#!/usr/bin/env python3
"""Manage native particle wallpaper with a Chromium rollback."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

BASE=Path(__file__).resolve().parent
EXT=Path.home()/'.local/share/gnome-shell/extensions/hanabi-extension@jeffshee.github.io'
PROJECT=BASE.parent/'starry-night-particle-wallpaper/project.json'
UUID='hanabi-extension@jeffshee.github.io'
METRICS=Path(os.environ.get('XDG_RUNTIME_DIR',f'/run/user/{os.getuid()}'))/'hanabi-native-metrics.json'


def process_ids():
    ids=[]
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():continue
        try:
            cmd=(proc/'cmdline').read_bytes().replace(b'\0',b' ').decode()
            if (cmd.startswith('/opt/google/chrome/chrome') and '--user-data-dir='+str(Path.home()/'.cache/hanabi-chromium') in cmd) or cmd.startswith(str(EXT/'renderer/native/particle-wallpaper')):
                ids.append(int(proc.name))
        except OSError:pass
    return ids


def stop():
    subprocess.run(['gnome-extensions','disable',UUID],check=True)
    for _ in range(100):
        if not process_ids():return
        time.sleep(.1)
    raise RuntimeError('Old renderer has not exited; kept Hanabi disabled to prevent overlap')


def select(backend):
    project=json.loads(PROJECT.read_text())
    project.setdefault('hanabi',{})['renderer']=backend
    project['hanabi']['sharedView']=False
    PROJECT.write_text(json.dumps(project,indent=2,ensure_ascii=False)+'\n')


def enable():subprocess.run(['gnome-extensions','enable',UUID],check=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['install','restart','restore','status'])
    action=parser.parse_args().action
    if action=='status':print(METRICS.read_text());return
    stop()
    if action=='restore':select('chromium');enable();print('Restored Chromium');return
    if action=='install':
        target=EXT/'renderer/native';target.mkdir(exist_ok=True)
        shutil.copy2(BASE/'build/particle-wallpaper',target/'particle-wallpaper')
        shutil.copy2(BASE/'bridge.js',target/'bridge.js')
        shutil.copytree(BASE/'shaders',target/'shaders',dirs_exist_ok=True)
        wrapper=EXT/'renderer/renderer.js'
        backup=BASE/'research/renderer-before-native.js'
        if not backup.exists():shutil.copy2(wrapper,backup)
        wrapper.write_text('''import Gio from 'gi://Gio';
const index=ARGV.indexOf('-F');
let backend='webkit';
try {if(index>=0){const [ok,data]=Gio.File.new_for_path(ARGV[index+1]+'/project.json').load_contents(null);if(ok)backend=JSON.parse(new TextDecoder().decode(data)).hanabi?.renderer;}} catch {}
await import(backend==='native'?'./native/bridge.js':backend==='chromium'?'./chromium/bridge.js':'./renderer-webkit.js');
''')
    select('native')
    if METRICS.exists():METRICS.unlink()
    enable()
    for _ in range(30):
        time.sleep(1)
        try:
            metrics=json.loads(METRICS.read_text())
            if len(metrics)==2 and all(v['framesRendered']>=150 and v['fps']>30 for v in metrics.values()):
                print('Native active:',json.dumps(metrics));return
        except (OSError,ValueError):pass
    stop();select('chromium');enable()
    raise RuntimeError('Native startup check failed; restored Chromium')

if __name__=='__main__':main()
