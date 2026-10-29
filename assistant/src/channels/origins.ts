/**
 * Extra HTTPS origins the web panel answers on, e.g. `tailscale serve` publishing it to the operator's phone. The proxy
 * reaches the loopback listener, so only the Host/Origin pair changes; each one must be an exact `https://host` origin.
 * Returns host -> origin.
 */
export function remoteOrigins(origins: readonly string[]): Map<string, string> {
  const byHost = new Map<string, string>();
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error(`Invalid web origin: ${origin}`); }
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error(`Invalid web origin: ${origin}`);
    byHost.set(url.host, origin);
  }
  return byHost;
}
