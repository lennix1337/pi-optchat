# Isolated computer browser

The default browser seam renders **plain text artifacts only** in a disposable Docker computer. The separate opt-in public HTTPS read path is described below. The legacy unbound `navigate` API still fails closed; it does not provide an origin grant. A top-level URL check cannot enforce redirects, subresources, DNS and all browser requests, so network access must not be enabled on this container. The computer uses Docker `--network none`, no host mounts, a non-root user, dropped capabilities and a read-only root. Data and browser state are ephemeral in its private tmpfs. The image must already contain `agent-browser` and Chromium; it is never pulled by the manager.

A trusted host can create `ComputerManager` and a profile-scoped `Gateway`, then call `browserTextRequest(base, computer, text)` and `openBrowserText(gateway, computers, request)` from `assistant/src/computer/effects.ts`. The base is the usual versioned gateway metadata (profile, session, task, run, operation, policy version and expiry). The returned string is the browser accessibility snapshot. Text is bounded to 1000 UTF-8 bytes, escaped into an inert data document with a restrictive CSP, and opened in a fresh session. The gateway binds profile, computer, container and exact text; policy and review apply. This is not an HTML preview and must not be represented as external navigation.

`pause` blocks agent operations; only the configured operator authority can `resume`, `takeover`, or `handBack`. `takeover` returns a terminal argv for the operator; graphical takeover is the separate section below. The caller must destroy computers or run owner-scoped cleanup and close the manager and gateway. Container workspaces disappear on removal. The host must keep the authority object private and must not expose raw manager `exec` to untrusted callers; the trusted host is responsible for gateway-only dispatch. As with existing computer operations, an already running action can race with takeover; pause/takeover is not a transactional cancellation mechanism.

## Operator commands

With Node 24+, Docker and a locally installed browser image (default `optchat-computer-browser:1`), run:

```text
node assistant/scripts/computer.mjs status
node assistant/scripts/computer.mjs preview --text "A local text artifact"
```

Use `--image IMAGE` to select another already-present image. `status` only probes the engine and image. `preview` creates a unique temporary owner and database, dispatches the exact text through an operator-local allow policy and gateway, opens and snapshots it inside the offline container, then removes that owner's container and temporary database. Its JSON reports the snapshot and `containerCleanup`; it never opens a URL or uses accounts. Avoid sensitive text in command arguments, which may be visible to the operating system. This command's policy is not an integration with an assistant service's policy configuration.

If browser close fails or takeover blocks close, the API raises `computer_browser_cleanup_failed` with `sessionId`, `container` and `cleanupReason`; the gateway intent remains uncertain. It does not bypass takeover to close the browser. The operator must inspect the owned computer and hand it back or destroy it as appropriate. The standalone preview reports this failure even if it subsequently removes its disposable container. If container cleanup fails, it reports the unique owner and retained temporary database directory for operator recovery; do not remove containers belonging to another owner.

Cleanup and destroy must retain recovery records when Docker inspection or removal is uncertain. A successful full container listing may confirm an already-absent container; an inspection error alone may not. Removal targets an inspected immutable container ID, not a reusable name. Partial cleanup reports `computer_cleanup_failed` and leaves failed or foreign-replaced tracked resources recorded; untracked foreign containers are ignored. A failed destroy or owner cleanup can be retried: the reservation records the immutable container ID before `docker rm`, and a later destroy/cleanup takes it over only when inspecting that ID shows the earlier operation settled (the ID is absent from a full listing, or present and not `removing`). An unreadable daemon, a container still being removed, or an overlapping in-flight operation is refused with `computer_transition`/`computer_cleanup_active`.

Authenticated browsing over the network and unrestricted navigation are **not provided** by the offline text preview or the public-read path below (that path is credential-free and read-only by design).

## Graphical takeover of the agent's own computer (library only)

`beginGraphicalTakeover` (`src/computer/graphical-takeover.ts`) shows the operator the agent's **own** container, not a copy: the same browser process, cookies and profile. It starts only a viewer (x11vnc bound to the container loopback, refusing a second controller, plus the noVNC page) and serves it on `127.0.0.1` through `docker exec` STDIO; no port is published. The host supplies `authorizeOwner` (token/cookie check, expiry); requests need the exact loopback `Host`, an exact `Origin` for the websocket, and only one websocket controller at a time. While the takeover lasts the computer is in state `graphical`: agent `exec`, `capture`, relays and browser calls are refused in every process (`computer_human_control`). `handBack` closes the sockets, stops the viewer (proven by the container's own process list, retried on failure) and returns the unchanged computer; whatever the operator typed stays only inside that container. Nothing is copied to the host, the database or logs, and a failed start or unproven stop never gives the computer back.

The operator can only see a browser that runs on the computer's virtual display. Start the agent's browser with `onTakeoverDisplay(['agent-browser', '--session', id, '--headed', 'open', url])` (`src/computer/takeover-session.ts`); it also keeps the displayed browser's temp files on the 256 MiB `/work` tmpfs because the 32 MiB `/tmp` is exhausted by a displayed Chromium. The image `assistant/computer/takeover.Dockerfile` (build locally on top of `optchat-computer-browser:1`) provides Xvfb, x11vnc, websockify and noVNC.

Limits: the container keeps `--network none`, so a *real* remote login page is still out of reach — the public-read broker strips cookies and refuses form posts, and a credentialed egress path would need its own approved design. The proof (`assistant/test/takeover-login-continuation.test.ts`) uses a disposable login site running inside the agent's container on its loopback: the agent's browser loads the form, a scripted operator logs in through the takeover websocket, and after handback the agent's next page load is authenticated.

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

