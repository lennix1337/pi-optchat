// Pure policy shared by the in-container relay and hermetic adversarial tests.
export function relayReadHeaders(origin, req, pending, issued) {
  const hosts = req.rawHeaders.filter((_, i) => i % 2 === 0).filter(name => name.toLowerCase() === 'host');
  if (hosts.length !== 1 || req.headers.host?.toLowerCase() !== new URL(origin).host) return null;
  if (!req.url?.startsWith('/') || !['GET', 'HEAD'].includes(req.method)) return null;
  if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) return null;
  if (req.headers.authorization !== undefined || req.headers['proxy-authorization'] !== undefined || req.headers.cookie !== undefined || req.headers.upgrade !== undefined) return null;
  if (pending >= 16 || issued >= 512) return null;
  const headers = {};
  for (const name of ['accept', 'accept-language', 'user-agent', 'range', 'if-none-match', 'if-modified-since']) {
    if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
  }
  return headers;
}

export function relayConnectTarget(authority, head, contexts) {
  if (head.length) return undefined;
  return contexts.get(authority?.toLowerCase());
}
