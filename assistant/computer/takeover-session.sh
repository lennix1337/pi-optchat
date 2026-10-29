#!/bin/sh
set -eu
export DISPLAY=:98
mkdir -p /work/takeover-profile
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
xvfb=$!
sleep 1
x11vnc -display "$DISPLAY" -localhost -rfbport 5908 -forever -shared -nopw -quiet >/dev/null 2>&1 &
vnc=$!
websockify --web /opt/optchat/takeover/public 127.0.0.1:6088 127.0.0.1:5908 >/dev/null 2>&1 &
web=$!
trap 'kill "$web" "$vnc" "$xvfb" 2>/dev/null || true' EXIT INT TERM
chromium-browser --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-background-networking --user-data-dir=/work/takeover-profile 'data:text/html,%3Ctitle%3EOffline%20login%20fixture%3C%2Ftitle%3E%3Ch1%3EOffline%20login%3C%2Fh1%3E%3Clabel%3ECode%20%3Cinput%20type%3Dpassword%3E%3C%2Flabel%3E' >/dev/null 2>&1
