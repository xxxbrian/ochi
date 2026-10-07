#!/usr/bin/env bash
set -euo pipefail

if [[ "${COMPUTE_ONLY:-0}" == "1" && "$(id -u)" == "0" ]]; then
  # Only established replies, loopback, Docker DNS and public egress. The API
  # service can reach this bridge, but code cannot initiate connections to it,
  # persistent workspaces, Docker gateways or private LAN addresses.
  iptables -P OUTPUT DROP
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -o lo -j ACCEPT
  for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do
    iptables -A OUTPUT -d "$destination" -j REJECT
  done
  iptables -A OUTPUT -j ACCEPT
  ip6tables -P OUTPUT DROP
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -d fc00::/7 -j REJECT
  ip6tables -A OUTPUT -d fe80::/10 -j REJECT
  ip6tables -A OUTPUT -j ACCEPT
  mkdir -p /data/files /data/work /data/published /data/runs /data/logs
  chown assistant:assistant /data /data/files /data/work /data/published /data/runs /data/logs
  # Container initialization needs NET_ADMIN; neither the bridge nor user code
  # retains that capability or can regain it through exec.
  exec setpriv --reuid=assistant --regid=assistant --init-groups --bounding-set=-all /usr/local/bin/workspace-entrypoint
fi

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-assistant}"
mkdir -p "$XDG_RUNTIME_DIR" /data/files /data/profile /data/work /data/projects /data/published /data/browser-profiles
chmod 700 "$XDG_RUNTIME_DIR" || true

# Keep agent-installed Python and Node dependencies across container replacement.
# Bridge dependencies stay in the image; user code gets its own persistent env.
if [[ ! -x /data/venv/bin/python ]]; then
  /usr/bin/python3 -m venv --system-site-packages /data/venv
  printf '\n/opt/venv/lib/python3.11/site-packages\n' > /data/venv/lib/python3.11/site-packages/workspace-base.pth
fi
mkdir -p /data/npm /data/cache/npm /data/cache/pip
export PATH="/data/venv/bin:/data/npm/bin:$PATH"
export VIRTUAL_ENV=/data/venv
export npm_config_prefix=/data/npm
export npm_config_cache=/data/cache/npm
export PIP_CACHE_DIR=/data/cache/pip

if [[ "${COMPUTE_ONLY:-0}" == "1" ]]; then
  unset DISPLAY DBUS_SESSION_BUS_ADDRESS SESSION_MANAGER
  exec /opt/venv/bin/python /opt/workspace/bridge.py
fi

# The desktop, bridge and activated accessibility services share one private
# session bus. Preferences live in the existing data volume; user files and
# old browser profiles are neither moved nor recursively chowned.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/desktop/config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/data/desktop/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/data/cache/desktop}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-/data/desktop/state}"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
/usr/bin/python3 /opt/workspace/desktop-prepare.py

xvfb_pid=""
bus_pid=""
desktop_pid=""
bridge_pid=""
vnc_pid=""
view_vnc_pid=""
websocket_pid=""
view_websocket_pid=""
children=()

start_group() {
  local name="$1" log="$2"
  shift 2
  setsid "$@" >"$log" 2>&1 &
  printf -v "${name}_pid" '%s' "$!"
  children+=("$!")
}

wait_for_exit() {
  local pid="$1" attempts="$2"
  [[ -n "$pid" ]] || return 0
  for ((attempt = 0; attempt < attempts; attempt++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
}

signal_group() {
  local signal="$1" pid="$2"
  [[ -n "$pid" ]] && kill "-$signal" -- "-$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  set +e
  # Keep X and DBus alive while the bridge closes browser profiles. The fallback
  # reaches independently managed Chromium mains, not their renderer children.
  [[ -n "$bridge_pid" ]] && kill -TERM "$bridge_pid" 2>/dev/null
  wait_for_exit "$bridge_pid" 40
  /usr/bin/python3 - <<'PY'
import contextlib
import os
from pathlib import Path
import signal
import time

processes = []
for entry in Path('/proc').iterdir():
    if not entry.name.isdecimal():
        continue
    with contextlib.suppress(OSError, ValueError):
        if entry.stat().st_uid != os.getuid():
            continue
        arguments = (entry / 'cmdline').read_bytes().split(b'\0')
        if Path(os.fsdecode(arguments[0])).name != 'chromium' or any(arg.startswith(b'--type=') for arg in arguments):
            continue
        pid = int(entry.name)
        os.kill(pid, signal.SIGTERM)
        processes.append(pid)
deadline = time.monotonic() + 2
while processes and time.monotonic() < deadline:
    processes = [pid for pid in processes if Path(f'/proc/{pid}').exists()]
    if processes:
        time.sleep(0.1)
PY
  for pid in "$desktop_pid" "$bridge_pid" "$websocket_pid" "$view_websocket_pid" "$vnc_pid" "$view_vnc_pid"; do
    signal_group TERM "$pid"
  done
  wait_for_exit "$desktop_pid" 20
  for pid in "$desktop_pid" "$bridge_pid" "$websocket_pid" "$view_websocket_pid" "$vnc_pid" "$view_vnc_pid"; do
    signal_group KILL "$pid"
  done
  # xfconfd/dconf can persist pending settings before their session bus stops.
  signal_group TERM "$bus_pid"
  wait_for_exit "$bus_pid" 5
  signal_group KILL "$bus_pid"
  signal_group TERM "$xvfb_pid"
  wait_for_exit "$xvfb_pid" 5
  signal_group KILL "$xvfb_pid"
  for pid in "${children[@]}"; do wait "$pid" 2>/dev/null; done
}
trap cleanup EXIT
trap 'exit 0' INT TERM

start_group xvfb /tmp/xvfb.log Xvfb "$DISPLAY" -screen 0 1280x800x24 -ac -nolisten tcp +extension RANDR

for attempt in {1..50}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null

start_group bus /tmp/dbus-session.log dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS"
for attempt in {1..50}; do
  if dbus-send --session --type=method_call --print-reply --reply-timeout=1000 \
    --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1; then break; fi
  sleep 0.1
done
dbus-send --session --type=method_call --print-reply --reply-timeout=1000 \
  --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null

start_group desktop /tmp/xfce-session.log /usr/local/bin/workspace-desktop-start
desktop_ready=0
for attempt in {1..150}; do
  if pgrep -x xfwm4 >/dev/null && pgrep -x xfsettingsd >/dev/null \
    && pgrep -x xfce4-panel >/dev/null && pgrep -x xfdesktop >/dev/null; then
    desktop_ready=1
    break
  fi
  kill -0 "$desktop_pid" 2>/dev/null || break
  sleep 0.1
done
if [[ "$desktop_ready" != "1" ]]; then
  echo "workspace desktop failed to start; see /tmp/xfce-session.log" >&2
  tail -n 30 /tmp/xfce-session.log >&2
  exit 1
fi

# Applications and browsers are opened lazily, not on every Computer call.
# VNC TCP stays loopback-only; private websocket ports are reached exclusively
# through the Go service's authenticated proxy. View-only is server-enforced.
start_group vnc /tmp/vnc.log x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -nopw -forever -shared -noxdamage -quiet
start_group view_vnc /tmp/vnc-view.log x11vnc -display "$DISPLAY" -rfbport 5901 -localhost -nopw -forever -shared -viewonly -noxdamage -quiet
start_group websocket /tmp/websockify.log /opt/venv/bin/python -m websockify 0.0.0.0:6080 127.0.0.1:5900
start_group view_websocket /tmp/websockify-view.log /opt/venv/bin/python -m websockify 0.0.0.0:6081 127.0.0.1:5901
start_group bridge /tmp/workspace-bridge.log /opt/venv/bin/python /opt/workspace/bridge.py

# A failed desktop/VNC/bridge must not leave a deceptively healthy partial
# workspace behind. Tini reaps daemon children; cleanup owns process groups.
set +e
wait -n "${children[@]}"
status=$?
set -e
echo "workspace service exited unexpectedly (status $status)" >&2
exit "$((status == 0 ? 1 : status))"
