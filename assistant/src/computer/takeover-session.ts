/**
 * Shell fragments for graphical takeover of an agent's own computer. They run inside the network-none
 * container; the host only ever executes them through `docker exec` on the container's immutable ID.
 * The packages they need (Xvfb, x11vnc, websockify, noVNC bundle) come from takeover.Dockerfile.
 */
export const TAKEOVER_DISPLAY = ':98';
const STATE = '/tmp/optchat-takeover';

const ENSURE_DISPLAY = `pgrep -x Xvfb >/dev/null 2>&1 || { Xvfb ${TAKEOVER_DISPLAY} -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 & i=0; while [ ! -S /tmp/.X11-unix/X${TAKEOVER_DISPLAY.slice(1)} ] && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done; }`;

/**
 * A displayed Chromium keeps its shared memory (agent-browser always passes --disable-dev-shm-usage) and profile in the
 * temp directory. The 32 MiB /tmp tmpfs is exhausted within a login flow and navigations then fail with
 * ERR_INSUFFICIENT_RESOURCES, so a displayed browser uses the computer's larger /work tmpfs for its temp files.
 */
const DISPLAYED_BROWSER_TMP = '/work/tmp';

/**
 * Wraps a command so it runs on the computer's virtual display. A browser the agent starts this way
 * (`agent-browser --headed`) is the one the operator sees and drives during takeover: same process, same cookies.
 */
export function onTakeoverDisplay(argv: readonly string[]): string[] {
  return ['sh', '-c', `${ENSURE_DISPLAY}; mkdir -p ${DISPLAYED_BROWSER_TMP}; exec env DISPLAY=${TAKEOVER_DISPLAY} TMPDIR=${DISPLAYED_BROWSER_TMP} "$@"`, 'sh', ...argv];
}

/**
 * Starts the viewer only: an x11vnc bound to the container's loopback that refuses a second controller, and the
 * noVNC page behind websockify. The display and the browser on it are left exactly as the agent made them.
 */
export const START_SESSION = `set -eu
d=${STATE}; mkdir -p "$d"; echo $$ > "$d/session.pid"
${ENSURE_DISPLAY}
x11vnc -display ${TAKEOVER_DISPLAY} -localhost -rfbport 5908 -nevershared -dontdisconnect -forever -nopw -quiet >/dev/null 2>&1 &
echo $! > "$d/x11vnc.pid"
websockify --web /opt/optchat/takeover/public 127.0.0.1:6088 127.0.0.1:5908 >/dev/null 2>&1 &
echo $! > "$d/websockify.pid"
wait`;

/** Probe that the viewer is up: both processes are alive and the noVNC page answers on loopback. */
export const SESSION_READY = `pgrep x11vnc >/dev/null && pgrep websockify >/dev/null && echo | socat - TCP:127.0.0.1:6088 >/dev/null`;

/** Idempotent: stops only the viewer processes recorded by START_SESSION and fails unless they are gone. */
export const STOP_SESSION = `d=${STATE}
for f in "$d"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
i=0; alive=1
while [ $i -lt 30 ] && [ $alive = 1 ]; do
  alive=0
  for f in "$d"/*.pid; do [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && alive=1; done
  [ $alive = 1 ] && sleep 0.1; i=$((i+1))
done
[ $alive = 0 ] || exit 1
rm -f "$d"/*.pid; exit 0`;
