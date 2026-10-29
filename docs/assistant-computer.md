# Isolated computer browser

The default browser seam renders **plain text artifacts only** in a disposable Docker computer. The separate opt-in public HTTPS read path is described below. The legacy unbound `navigate` API still fails closed; it does not provide an origin grant. A top-level URL check cannot enforce redirects, subresources, DNS and all browser requests, so network access must not be enabled on this container. The computer uses Docker `--network none`, no host mounts, a non-root user, dropped capabilities and a read-only root. Data and browser state are ephemeral in its private tmpfs. The image must already contain `agent-browser` and Chromium; it is never pulled by the manager.

A trusted host can create `ComputerManager` and a profile-scoped `Gateway`, then call `browserTextRequest(base, computer, text)` and `openBrowserText(gateway, computers, request)` from `assistant/src/computer/effects.ts`. The base is the usual versioned gateway metadata (profile, session, task, run, operation, policy version and expiry). The returned string is the browser accessibility snapshot. Text is bounded to 1000 UTF-8 bytes, escaped into an inert data document with a restrictive CSP, and opened in a fresh session. The gateway binds profile, computer, container and exact text; policy and review apply. This is not an HTML preview and must not be represented as external navigation.

`pause` blocks agent operations; only the configured operator authority can `resume`, `takeover`, or `handBack`. Takeover returns a terminal argv for the operator, not a graphical browser or login flow. The caller must destroy computers or run owner-scoped cleanup and close the manager and gateway. Container workspaces disappear on removal. The host must keep the authority object private and must not expose raw manager `exec` to untrusted callers; the trusted host is responsible for gateway-only dispatch. As with existing computer operations, an already running action can race with takeover; pause/takeover is not a transactional cancellation mechanism.

## Operator commands

With Node 24+, Docker and a locally installed browser image (default `optchat-computer-browser:1`), run:

```text
node assistant/scripts/computer.mjs status
node assistant/scripts/computer.mjs preview --text "A local text artifact"
```

Use `--image IMAGE` to select another already-present image. `status` only probes the engine and image. `preview` creates a unique temporary owner and database, dispatches the exact text through an operator-local allow policy and gateway, opens and snapshots it inside the offline container, then removes that owner's container and temporary database. Its JSON reports the snapshot and `containerCleanup`; it never opens a URL or uses accounts. Avoid sensitive text in command arguments, which may be visible to the operating system. This command's policy is not an integration with an assistant service's policy configuration.

If browser close fails or takeover blocks close, the API raises `computer_browser_cleanup_failed` with `sessionId`, `container` and `cleanupReason`; the gateway intent remains uncertain. It does not bypass takeover to close the browser. The operator must inspect the owned computer and hand it back or destroy it as appropriate. The standalone preview reports this failure even if it subsequently removes its disposable container. If container cleanup fails, it reports the unique owner and retained temporary database directory for operator recovery; do not remove containers belonging to another owner.

Cleanup and destroy must retain recovery records when Docker inspection or removal is uncertain. A successful full container listing may confirm an already-absent container; an inspection error alone may not. Removal targets an inspected immutable container ID, not a reusable name. Partial cleanup reports `computer_cleanup_failed` and leaves failed or foreign-replaced tracked resources recorded; untracked foreign containers are ignored. Inspect retained owner-scoped records before any retry.

Graphical browser takeover, authenticated browsing and unrestricted navigation are **not provided** by the offline text preview or the public-read path below.

## Opt-in public HTTPS reads

Build the separate image once (the existing offline image is unchanged):

```text
docker build --pull=false -f assistant/computer/egress.Dockerfile -t optchat-computer-browser-egress:1 assistant/computer
node assistant/scripts/browse.mjs --url https://httpbingo.org/html --origin https://httpbingo.org
```

Use only explicitly authorized **public read URLs**. Origin grants permit bounded GET/HEAD requests across that exact origin, including queries; GET can still trigger side effects on poorly designed sites. Never use account URLs, private query data, or this command as authority to interact with an unrelated service. Add each intended redirect/subresource origin explicitly via another `--origin`; page content cannot grant one. Ports other than 443, IP-literal origins, HTTP downgrade, uploads, cookies, Authorization and WebSockets are refused. Some sites will not work under these restrictions. Snapshots are untrusted page data, not instructions.

The browser stays `--network none`, read-only, non-root and without host mounts. A TLS-inspecting proxy listens only on container loopback; requests cross `docker exec -i` STDIO to a bounded host broker (no host listener or Docker network). A temporary CA and keys are generated inside `/work`; only that container's HOME/NSS store trusts it. Trust and key files are removed on clean relay shutdown, and the ephemeral workspace disappears on container removal. Windows trust and the user's browser profiles are not touched. During the read, the trusted host sees plaintext public requests/responses; this is **not end-to-end TLS from Chromium**. The host verifies upstream TLS certificates and uses the original hostname/SNI on a fresh socket pinned to one validated IP.

For **every request**, the broker rechecks the computer's profile, ready state and authority deadline, the exact origin, method, headers and all DNS answers. Mixed public/private DNS results fail closed; the HTTPS client does not resolve again or follow redirects. Browser redirects, fetches and subresources must pass the same policy independently. Limits: 16 concurrent requests, 512 per relay, 120s lifetime (or earlier authority expiry), 2 MiB per response. Pause/takeover/expiry ends the broker and aborts its in-flight sockets; revocation is observed on a 100ms timer, not transactionally at the moment of an operator click.

Trusted integration: `browserReadRequest(base, computer, {url, origins})` and `openBrowserRead(gateway, computers, request)` in `assistant/src/computer/browser-egress.ts`. Gateway review binds profile, computer/container, exact URL and grant set; modified payloads require a new review, and operation IDs cannot replay. Its result contains the accessibility snapshot, CA fingerprint and count of broker-denied requests (not every in-container refusal). Cleanup errors keep the gateway outcome uncertain. The trusted host must keep broker/transport injections and raw computer exec inaccessible to untrusted callers.

Checks are discoverable in `.pi/checks.json`: `assistant-browser-egress` (hermetic), `assistant-browser-egress-mutations`, `assistant-browser-egress-docker` (local controlled upstream) and `assistant-browser-egress-live` (explicit credential-free reads to httpbingo.org). None pulls images or activates a personal service. No Pi reload is required for the disposable CLI; installing the changed Pi adapter and personal-service activation remain separate operations.

