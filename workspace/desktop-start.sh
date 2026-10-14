#!/usr/bin/env bash
set -euo pipefail

export XDG_CURRENT_DESKTOP=XFCE
export XDG_SESSION_DESKTOP=xfce
export DESKTOP_SESSION=xfce
export GTK_A11Y=1
export NO_AT_BRIDGE=0

# Activated GTK/AT-SPI services need the same display and persistent settings as
# the bridge. No system bus, display manager or privileged desktop is required.
dbus-update-activation-environment DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR \
  XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME \
  XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP DESKTOP_SESSION GTK_A11Y NO_AT_BRIDGE \
  PATH LANG LC_ALL
gsettings set org.gnome.desktop.interface toolkit-accessibility true
dbus-send --session --print-reply --reply-timeout=5000 --dest=org.a11y.Bus \
  /org/a11y/bus org.a11y.Bus.GetAddress >/dev/null

xset s off
xset -dpms >/dev/null 2>&1 || true
exec xfce4-session
