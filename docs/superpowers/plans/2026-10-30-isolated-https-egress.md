# Isolated HTTPS egress implementation plan

Goal: extend the disposable computer with explicitly granted public HTTPS reads, preserving network-none isolation and a container-only certificate authority. Operator accepted the inspecting proxy boundary after message 80396. This does not activate a personal service, trust a CA on Windows, or authorize account login, publishing, or production writes.

Architecture: browser container remains `--network none`. A loopback HTTP CONNECT/TLS proxy in the container relays bounded HTTP requests over `docker exec -i` JSON lines to a trusted Node broker. The broker checks the active computer, exact granted HTTPS origin, GET/HEAD, absence of credentials, and all DNS answers before each connection. HTTPS connects to the checked IP with original hostname certificate verification/SNI, without redirects or connection reuse. Each redirected/subresource request is independently checked. Broker returns bounded responses. No generic TCP tunnel, container network, host mount, host listener, or host CA is introduced.

Scope: public HTTPS :443 only, bounded reads, no cookies/Authorization, WebSocket, upload, HTTP downgrade or form submission. Website GET endpoints may have side effects: origin grants must still be deliberate. Untrusted page contents never authorize further origins. Revocation/expiry/pause/takeover stops broker requests. Offline text preview remains unchanged.

## Steps and acceptance
- [x] Add host broker and adversarial tests. Prove rejection of private/mixed DNS, ungranted origin, non-HTTPS, writes, credentials, headers and oversized bodies. Test actual TLS fetch wiring with pinned resolver and certificate validation; no general TLS bypass.
- [x] Add container relay and separate image `optchat-computer-browser-egress:1` with OpenSSL/NSS certificate utilities. Generate ephemeral CA/key and fixed-origin leaf certificates only inside `/work`; import trust only into disposable HOME. Validate CONNECT target, per-request Host, framing, timeouts, bounds and no upgrade/tunnel.
- [x] Add gateway-bound navigation adapter and operator-only disposable `browse` command with explicit `--origin` grants. Payload binds computer/profile/container/URL/origins; no implicit grants. Admission is rechecked after awaits and during the broker lifetime. Close sessions and relay before owner-scoped cleanup; preserve uncertain cleanup records.
- [x] Add inspected project checks and mutation controls for every new admission boundary.
- [x] Build separate image locally. Use real agent-browser in locked-down container to navigate a granted public page and obtain its snapshot. Verify direct TCP/DNS fail, HTTP downgrade/ungranted redirect/subresources fail, container network stays none and no host mounts/trust changes. Confirm owner-scoped cleanup.
- [x] Run affected Docker tests, both typechecks, unit, Ripwire edit-check/quality/test-gate and scoped diff review. Record evidence outside Git; update coverage/progress/docs without claiming complete product parity or personal activation.

No delegation needed for this cohesive security boundary. Preserve all existing dirty files and worktrees.

Outcome: scoped public read path verified; no personal activation or publication. Evidence: `C:/projetos/local-validation/runs/assistant-connections-20261029/egress-result.md`. Checks: 8 hermetic, 37/37 killed mutants, 2 controlled Docker, 2 public live, 20 existing Docker, both typechecks, discovery1 and unit904/0/1 existing skip. Scoped parent review and Ripwire quality gating0; independent reviewer not launched. API still intentionally excludes accounts, forms, graphical takeover and unrestricted navigation. Personal service restart/Pi reload remain pending consent.
