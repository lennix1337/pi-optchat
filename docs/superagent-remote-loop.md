# Remote loop: what it would need (design note, not built)

Status: design only, local-only today. Scope of the local split (item 12): compute, state and environment are separated in code, but everything still runs on the operator's machine. Nothing here starts a host, a daemon on another machine, or a paid service.

**Cost decision (operator):** a remote loop means a machine that runs the agent and the environment all day. Hosting costs money every month. Whether and where to host it is the operator's decision; this note only lists what would have to exist.

## What is already separated

| Concern | Local code today | Seam |
|---|---|---|
| Effects to Slack, WhatsApp, notifications | `outbox` table in the same transaction as the state change (`assistant/src/outbox/outbox.ts`, `docs/state-machines.md` §38) | `Outbox.stage / dispatch / perform / reconcile` |
| Environment actions (Docker, toast, DPAPI, viewer streams) | allow-list table `assistant/src/environment/actions.ts` | `Environment.run / open` |
| Environment over loopback | `assistant/src/environment/daemon.ts`: bearer token from a private token file, `127.0.0.1` only, one-shot actions only | `daemonEnvironment(endpoint, token)` |
| State | SQLite files, one per store (task store, relay, vault, notifications, computers, routines) | not yet behind one interface (see Gaps) |

## What a remote loop would add

1. **Transport and identity for the environment.** The loopback daemon uses a shared bearer token in a file on the same machine. Across machines it needs TLS with a pinned certificate or a private network, per-host credentials that can be rotated and revoked, and a way to bind a request to one assistant profile. The allow-list stays the same: a remote caller still cannot name a process, a flag or a host path.
2. **Streams.** Viewer and relay streams (`docker_stream`) are live pipes and are refused over the daemon today. A remote loop needs a stream protocol with flow control, reconnect, and an explicit end; until then the viewer runs only on the machine that holds the container.
3. **State behind one store.** Each SQLite file is local. A remote loop needs either one networked store with the lease and fencing already in `runtime/worker.ts`, or per-host stores with replication. The outbox is safe across hosts only if every provider call carries the idempotency key (it already does) and a single host owns each row at a time (`recover()` assumes one live process per relay database).
4. **Secrets.** The vault wraps its key with DPAPI (current Windows user, this machine). A remote host needs its own key protector, and the operator must decide how secrets reach it. Nothing secret should travel in argv, logs or the outbox payload.
5. **Egress and inbound reach.** Slack and Teams deliver signed requests or Socket Mode connections; a remote loop must keep those boundaries (signature, workspace, sender checks) and must not open a new inbound port to the internet.
6. **Operations.** Backup and restore of every store, a health probe, start/stop ownership (the ops service already tracks pid and start time locally), and a kill switch that the operator can reach from the phone.
7. **Cost controls.** Spending limits on the host and on model calls, and a stop rule when the budget is reached. These need the operator's numbers.

## Gaps today (not done)

- **Store interface.** Only the Slack relay and its outbox go through one transaction helper (`store/transaction.ts`). The other SQLite stores still open their own connections. One interface for state is the next step, and it touches every store module.
- **Remaining direct spawns.** Still on `child_process` outside the port: `connectors/stdio.ts` (operator-configured MCP servers; an allow-list does not fit arbitrary commands), `ops/service.ts` (`spawnSync` probes and the service's own launch), `store/privacy.ts` and `store/private-directory.ts` (`spawnSync` ACL checks). The port is async-only; these depend on `spawnSync` error and timeout classes, so they move with a synchronous method, not by a silent change.
- **Daemon not started by the service.** `daemon.ts` is implemented and tested; the service still uses the in-process adapter behind the same interface. Wiring it into startup changes the live service and needs its own decision.
- **Second outbox.** `runtime/worker.ts` has an `outbox` table marked `delivered` after the send, in a separate transaction. It has no caller in `src` today. Move it onto `Outbox` before it gets one.

## Suggested order if the operator decides to host

1. Store interface for every service database, with the outbox and fencing as the only writers of effects.
2. Daemon started by the service, with a per-host token and a rotation command.
3. TLS or private network for the daemon; a test that refuses non-loopback clients without the new transport.
4. Remote key protection for the vault.
5. A hosted trial with a spending limit set by the operator, measured against the local run.
