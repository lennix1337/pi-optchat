![Pi-OptChat: persistent memory for Pi](https://raw.githubusercontent.com/jonaslsaa/pi-optchat/main/docs/banner.jpg)

# pi-optchat

**Persistent memory, supervised agents, and safer long-running work inside Pi.**

This is [lennix1337's fork](https://github.com/lennix1337/pi-optchat) of [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat), built on [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). One endless chat per profile, remembered through a summary tree rather than repeatedly replacing the conversation with a single summary. Originals stay available through `zoom`.

- **Memory**: every message is logged and summarized into a binary tree. Each turn starts from a fresh context holding a bounded memory view; the agent uses `zoom` and `date` to read originals.
- **Profiles**: separate memories and instructions, such as `work` and `personal`.
- **Subagents**: delegate tasks to background agents, inspect them live, and send them guidance.
- **Import**: bring in history from Claude Code (conversations and memories), Codex, Pi and [OMP](https://github.com/can1357/oh-my-pi), or ChatGPT.
- **Connected windows**: a second Pi window on the same profile becomes a subagent you talk to directly.

It runs inside ordinary Pi, without a Pi runtime fork or separate launcher.

## What this fork adds

| Area | Current capabilities |
| --- | --- |
| **Long-running context** | Budgeted turn refresh preserves live instructions and the last complete tool exchange. System prompt, tool schemas and output allowance count toward the request budget; oversized retained input fails explicitly instead of silently losing instructions. [Details](#context-fidelity-and-request-budgets) |
| **Recovery safety** | A durable tool-operation journal blocks blind replay after uncertain effects. Structured objectives, decisions, constraints, authorizations and checks retain their source and evidence separately from narrative summaries. [Details](#recovery-safety-and-operational-state) |
| **Agents and shells** | Live agent trees, guidance, paged transcripts, usage/activity views, and a Shells panel with bounded output. Explicitly requested background jobs can be inspected and stopped. [Details](#agents-usage-and-activity-inspector) |
| **Account-aware models** | Compactor and subagent models follow the active main-model account, with per-provider fallbacks, including numbered multi-account providers. [Details](#models) |
| **Compactor reliability** | Metadata-only diagnostics, bounded pre-response retries, interrupted-stream classification, persisted policy-refusal stops, and measured summary-size correction. Originals are retained when summarization fails. [Details](#long-runs-and-compactor-diagnostics) |
| **Memory beyond Pi** | Optional atomic `~/.optchat/status.md` snapshots and summary-block sync to the [Rust OptMem binary](https://github.com/lennix1337/OptMem) and history pages in a local [ai-memory](https://github.com/akitaonrails/ai-memory) server, without extra model calls for syncing. All are off by default. [Settings](#settings) |
| **Native Windows** | Named-pipe profile locks and connected windows, Windows-safe storage, and Pi 1.2 runtime compatibility tests alongside the offline suite. No WSL required. |

This remains a **TypeScript Pi extension**; OptMem is the separate Rust companion. Provider requests consume your existing credentials and quota. Recovery is conservative, not exactly-once execution, a sandbox, or a guarantee against process crashes.

## Install

Install **this fork** from GitHub:

```sh
pi install git:github.com/lennix1337/pi-optchat
pi install npm:pi-web-access   # optional, for web search and page fetching
```

`npm:pi-optchat` and `git:github.com/jonaslsaa/pi-optchat` install upstream, not this fork. If switching, remove the existing OptChat package first so Pi does not load two copies. Profile data is kept when removing a package; back it up with Pi closed before switching implementations.

Requirements: Pi 1.2.0 (the development/test target), Node.js 22.19+, and Git. CI runs the offline suite on Linux and Windows; not every interactive or live-provider flow is covered by those tests.

Windows is supported natively, without WSL: install and start Pi as usual. Profile locks and connected-window channels use named pipes instead of Unix sockets. Offline and runtime compatibility checks do not establish that every interactive screen, import source or provider combination works end to end.

Web access is not bundled. Subagents load the Pi extensions you have installed (except pi-optchat itself), so installing `pi-web-access` gives web tools to the main agent and every subagent.

To uninstall this fork, run `pi remove git:github.com/lennix1337/pi-optchat`. Profile data is kept.

## Quick start

1. Restart Pi.
2. Choose **+ Create profile** and name it, for example `work`.
3. Chat normally.

The footer shows the active profile. Memory follows the profile across directories and Pi sessions. New sessions show the profile picker with the last-used profile first; resumed sessions restore their profile. To skip the picker, set `OPTCHAT_PROFILE=work` in your environment: interactive sessions then open that profile directly (if it is busy, you get the usual connect choice). Headless runs ignore it and still need `--optchat-profile`.

For headless use (`pi -p`, `--mode rpc`, other extensions' runners), pass `--optchat-profile work`. Without it, and without a saved profile in a resumed session, a headless run is plain Pi with no OptChat memory. If the requested profile can't open (misspelled, deleted, or open in another Pi), the run reports the error and doesn't answer.

If that profile is open in another Pi, `pi -p` joins it like a connected window: a subagent in that Pi answers, only its final reply goes to stdout, and the main agent gets the handoff. `--optchat-connect auto` (default) joins only when the profile is busy, `join` always joins (and fails if no Pi has the profile open), `off` reports the busy profile as an error. A failed join exits non-zero.

## Commands

| Command | Action |
| --- | --- |
| `/optchat` | Status and actions menu. |
| `/optchat profile` | Select or create a profile. Switching starts a fresh Pi session. |
| `/optchat settings` | This profile's models and options, including turn refresh and import concurrency. |
| `/optchat model` | Compactor model and effort for this profile. Type to filter the models you are logged in to; the current one is marked. |
| `/optchat fallback` | Per-provider models for the compactor: what it runs while the main model is on another provider. `/optchat agents fallback` does the same for subagents. |
| `/optchat agents` | Live agent tree and saved run history. |
| `/optchat shells` | Inspect shell calls, managed background jobs and bounded output. |
| `/optchat agents model` | Subagent model and effort for this profile, picked the same way. |
| `/optchat usage` | Token usage and cost estimates. |
| `/optchat retry-summary <start>+<size>` | Explicitly retry one policy-blocked summary with the current compactor; never retries the main request or changes providers. |
| `/optchat activity` | Memory gauge: view size, summaries catching up, running agents. |
| `/optchat instructions` | Edit this profile's `AGENTS.md`. |
| `/optchat browse` | Open a readable snapshot of memory: the shape of what the model sees, summaries you can open down to the original messages, and search that shows where each message is folded. Run again to refresh. |
| `/optchat import` | Import history, or resume/discard a paused import. |
| `/heartbeat` | Today's heartbeat wakes (time, trigger, how the turn ended, its last reply, commits and pushes) and the wake budget left in the rolling 24 h. `/heartbeat queue` lists the idle-time work queue; `/heartbeat add <text>` appends an item to it. |
| `/complete` | In a connected window: end the conversation and hand off to the main agent. |
| `/tell-main <message>` | In a connected window: message the main agent. |

## Zoom in Code Mode

Prefer direct `zoom` for a single read or tree navigation: the next branch usually depends on the previous result. `n > 1` opens two child summaries; `n = 1` reads a message. Do not batch guesses at deeper nodes before reading their parent.

Pi can already run independent direct tool calls in one turn. Code Mode is optional for several already-identified, independent text-only reads, not a requirement for parallelism. It returns only what the script emits. Await every call and emit each result with its id; `Promise.allSettled()` keeps successful reads when another fails:

```js
const ids = [10, 11]; // Two independent messages whose text fits the combined output budget.
const results = await Promise.allSettled(ids.map(id => tools.zoom({ id, n: 1 })));
results.forEach((result, i) => text({ id: ids[i], ...(result.status === 'fulfilled'
  ? { result: result.value } : { error: String(result.reason) }) }));
```

Use character limits only when necessary, and follow next-page offsets until the needed text is read. Tiny pages create extra reads; oversized batches can truncate needed text. A successful nested call alone does not prove that its entire result reached the model. Pi's collapsed preview is separate: `Ctrl+O` expands it.

**Images:** use direct `zoom`. Pi 1.1.0's Code Mode converts this tool's result to text and drops its image attachments, leaving only image references. A text-only batch is not equivalent to viewing the original message's images.

## Models

| Role | Default | Change with |
| --- | --- | --- |
| Main agent | Whatever is selected in Pi | `/model` |
| Subagents | Anthropic Opus 5.5, high | `/optchat agents model` |
| Compactor (summaries, imports, handoffs) | Anthropic Haiku 5.5, xhigh (the recipe's cheap model) | `/optchat model` |

Subagent and compactor settings are saved per profile; the model each role *actually* uses follows the account the main model is on. Authentication uses Pi's existing provider login.

Give each role a model per provider (**Per-provider fallbacks** in `/optchat settings`, or `/optchat fallback` · `/optchat agents fallback`):

| Main model is on | Compactor or subagent runs |
| --- | --- |
| The provider of one of its fallbacks | That fallback's model, on the same account — numbered multi-account accounts included |
| The role's own provider (`anthropic`, like the default) | The role's own model, on the same account |
| Any other provider | The main model, at the lowest effort it takes |

The last row is why a role never keeps asking an account you've run out of: with no entry for the main model's provider, it runs on the account already answering.

A fallback may also be written by hand. One entry per provider family, so re-adding a family replaces its entry:

```json
"alternates": {
  "compactor": [{ "provider": "openai-codex", "model": "gpt-6-luna", "thinking": "high" }],
  "subagent": [{ "provider": "openai-codex", "model": "gpt-6-luna", "thinking": "xhigh" }]
}
```

Compression and subagents make extra model requests with your provider credentials.

## Long runs and compactor diagnostics

A long execution refreshes its context from the **same memory tree**, between complete tool exchanges, when its active transcript passes the configured **Turn refresh threshold** (30% of the selected model's context window by default). `OPTCHAT_REFRESH_AT` overrides it. Original messages are logged first. The task, live user instructions and last complete assistant/tool exchange remain exact; older executed exchanges stay available through `zoom`. This changes neither the tree algorithm nor its 128/64 KB view and 512-byte summaries.

Pi's automatic or manual compaction stores a snapshot of that existing view, with Pi's safe transcript boundary; it does not call a second summarizer or normally cancel compaction. Unbound Pi sessions retain Pi's own policy. A refresh refuses to drop unsummarized results if the compactor is failing. An input or retained exchange that cannot fit requires a smaller input or larger-context model, rather than silently losing data. Token checks use provider usage when available and Pi's size estimate otherwise, not an exact tokenizer.

Compactors keep the turns' system prompt and tool schemas for caching, but request `toolChoice: none`. Empty replies, tool calls and truncated responses are rejected, not saved as summaries. Before any HTTP 200, connection failures (refused, DNS, upstream connect errors), 502–504/529 or overload, and timeouts retry the same request up to two more times, after about 1 s and 2 s of abortable backoff. Originals are kept, no partial output enters the retry, and nothing retries after a response starts, on quota or authentication errors, or on cancellation. Ordinary failed nodes retry on the next message, as in the recipe; no model/effort switch is added. Typed provider policy refusals instead freeze that node, including across restart with the file store. Originals remain available. `/optchat retry-summary <start>+<size>` is an explicit user action for a named blocked node, not an automatic retry or provider-switch strategy.

Each attempt writes safe metadata to `<profile>/compactor-diagnostics.jsonl`: node, provider/model/API, requested/effective effort, duration, request sizes, event counts, HTTP status/request ID when available, native response status/ID, incomplete/error code, native content types/text byte counts, normalized stop reason, response block types/lengths and token usage. Native text bytes versus parsed text bytes help distinguish empty provider output from dropped SDK text. Transport failures record only an allowlisted code (for example `ECONNRESET` or `UND_ERR_HEADERS_TIMEOUT`), whether the request was aborted, and the elapsed time of the last stream event. Exceptions are otherwise categorized, not copied into this log. No prompts, message/summary text, reasoning text, tool arguments, authorization headers or tokens are recorded. Two rotating files are bounded to approximately 1 MB each and excluded from memory Git checkpoints.

Interrupted streams (`terminated`, a missing stop reason, or a socket reset) are categorized as `stream_interrupted`, separately from rate limits, cancellation and timeouts. The warning explains that the stream ended before a usable summary; original messages stay in memory and the failed node follows the existing background retry policy. No partial summary is saved and no immediate provider retry is added.

If `Compactor returned no text` or a stream interruption recurs, keep the matching diagnostic row (node and timestamp); an HTTP 200 alone does not prove a usable summary. Observed Luna stream interruptions recovered on subsequent node attempts, but whether the interruption originated in the network or upstream service remains unknown. The older intermittent empty-reply failures have not been reproduced in controlled live tests.

## Settings

`/optchat settings` opens this profile's settings. Each row shows its value and default, the selected row says what it does and when a change applies, and a change is saved right away to the profile's `config.json`. Defaults follow Victor's recipe.

| Setting | Default | What it does |
| --- | --- | --- |
| Compactor model | Haiku 5.5, xhigh | Same as `/optchat model`. Applies to the next summary. |
| Compactor fallbacks | none | Per-provider models for the compactor, one per provider family. Same as `/optchat fallback`. Applies to the next summary. |
| Subagent model | Opus 5.5, high | Same as `/optchat agents model`. Applies to new subagents. |
| Subagent fallbacks | none | Per-provider models for subagents, one per provider family. Same as `/optchat agents fallback`. Applies to subagents started after this. |
| Subagent levels | 1 | 1: only the main agent starts subagents. 2 or more: subagents may start their own, that many levels deep. Applies to subagents started or resumed after the change. |
| Max active agents | 8 | Subagents running at once in the profile, all levels together, so it also caps how deep a chain can go. |
| Group subagent reports | off | Off: each subagent reports as soon as it finishes (the recipe). On: the subagents started by one spawn report together, in one message once the last of them finishes. Applies to the next spawn. |
| Previous exchange | off | On: replays your last request and answer in full with the next turn, left out when over the limit. Off is the recipe: nothing carries over between turns. |
| Previous exchange limit | 16 KB | A larger last exchange is left out. |
| Memory search | off | Gives the agent, and subagents started or resumed after the change, a `search` tool over your original messages: plain text matching, newest first, never the summaries. Off is the recipe: zoom and date only. Applies from the next turn. |
| Sync: status file | off | Keeps `~/.optchat/status.md` current with this chat, so agents outside OptChat (Codex, Claude Code) can read what is going on: its oldest and newest memory lines (16 KB at most; what is left out is named) and its operational state. Written by code from memory, never a model: debounced after memory changes, at the end of each turn, on model switches and on exit; unchanged content is not rewritten. Point other agents at it from their AGENTS.md. |
| Sync: OptMem notes | off | Sends each finished block of 64 messages to [OptMem](https://github.com/lennix1337/OptMem) by running its binary, `memo note` (`~/.optmem/memo.exe` on Windows, `~/.optmem/memo` elsewhere; `OPTCHAT_MEMO` overrides it), as `[optchat a-b k/n]` notes of at most 280 bytes cut from the block's summary, so `memo recall` finds this chat's history. Starts at the newest finished block. A cursor in the profile (`optmem-sync.json`) sends each note once, a note already in OptMem's log is not resent after a crash, and a failure warns once and retries every minute. |
| Sync: ai-memory | off | Writes this chat to a local [ai-memory](https://github.com/akitaonrails/ai-memory) server (project `optchat`, workspace `default`) through its MCP endpoint (`AI_MEMORY_SERVER_URL`, default `http://127.0.0.1:49374`; token from `AI_MEMORY_AUTH_TOKEN` or the installer's `auth-token`): one page per finished block of 64 messages, `<profile>/blocks/<first>-<last>.md`, holding the block summary and every message's dated summary line, then `<profile>/status.md` after each block. Starts at block 0, so turning it on imports the whole history. A cursor in the profile (`ai-memory-sync.json`) writes each block once; page paths are fixed, so a write cut off by a crash is redone in place. A failure warns once and retries every minute. |
| Summary size tolerance | 512 bytes | The compactor targets 448 UTF-8 bytes for headroom below 512; a longer line up to this size is kept instead of retried. After five tries, the shortest complete line is kept even above this target, but must still be smaller than its source. Actual bytes count toward the view budget. |
| Import: summaries at once | 8 | Summaries an import builds at once, 1–64. Higher is faster but less accurate and uses more provider capacity; chat always runs 8. |
| Shell notices | every end | What the model hears when a background shell ends: every end, failures only (a non-zero exit or an error), or never. A `shell_start` call can set its own `notify`. Applies to shells started after the change. |
| Turn refresh threshold | 30% | Move completed exchanges into memory and continue with a fresh context when a run reaches this share of the model window. 0% disables it. Applies from the next call. |
| Turn refresh cap | 0 K tokens | Refresh the main agent's turn at this many tokens when that comes before the threshold, so a 1M-token window does not re-read a 300K-token turn on every call. 0 means no cap; `OPTCHAT_REFRESH_TOKENS` (in tokens) overrides it. Applies from the next call. |
| Heartbeat | 0 min (off) | After the chat has sat idle this long in interactive Pi, the compactor model (thinking off) reads why the last turn ended, the running agents and shells, the operational state, the profile's heartbeat plan and the newest 24 KB of the view, and answers `WAKE: <next step>` or `SLEEP: <reason>`. The check only wakes: a wake sends the main agent an `[OptChat heartbeat]` report that starts one turn, carrying the suggestion and the plan, and the main agent does the work. The plan is the `heartbeat` entry of `config.json`: `{ "jobs": [...], "allowed": [...], "never": [...] }`, each a list of text; jobs are tried in order. Without one, the jobs are stalled and unfinished work, allowed is branch work, checks and a pull request left ready for review, and never is merge, deploy, release, production writes, outside messages, paid generation and account changes. A quiet or failed check runs again one interval later, for as long as the chat stays idle. A question the agent left that the operator's earlier words already answer does not count as waiting on them. Checks are logged as `heartbeat` in usage. **Wake report:** each wake is kept in `heartbeat.json` (`wakeLog`, newest 48 within 7 days) with its time, trigger (fixed schedule, or the check's reason), when its turn ended, the turn's final reply (300 characters), its tool-call count and the `git commit` / `git push` results it made (`commit <sha> <branch>`, `push <old>..<new> <branch>`, read from successful `bash`/`powershell` git commands); an operator message or Esc during the wake marks it `interrupted`, an errored turn `error`, and one whose turn never settled (the session ended) `unsettled`. Read it with `/heartbeat`. **Work queue:** `heartbeat-queue.md` in the profile folder is a checklist you can edit: `- [ ] item` open, `- [x] item` done, `- [!] item (why)` blocked. A wake names the first open item and the file first, tells the agent to tick `- [x]` when finished or mark `- [!]` with the reason, and falls back to the plan jobs when no item is open. An item marked `- [!]`, or annotated `blocked:` / `(blocked ...)` / `[blocked]`, is never taken, and the plan's `allowed` and `never` still bind queue work. The cheap check also sees the next open item. |
| Heartbeat: fixed schedule | off | On: every heartbeat interval of idle time wakes the main agent with the plan, without asking the compactor model first (no check cost, a turn each time). A busy chat and the daily wake cap still apply. Off: the check decides each time. |
| Heartbeat wakes per day | 6 | The most turns the heartbeat may start in any 24 hours (counted in the profile's `heartbeat.json`, so a reload does not reset it); past it, a wake is shown as a notice instead. |

Numbers must be whole numbers of at least 1; the refresh threshold is 0–90%. Missing keys in an older `config.json` take their defaults.

**Upgrading from 0.6.x:** subagent levels used to be fixed at 3 and now default to 1, so subagents no longer start their own subagents until you set Subagent levels to 2 or 3.

![Settings page](docs/screenshots/settings.png)

## Subagents

Ask in plain words, for example: "Spawn an agent to investigate this repository and report back."

- Children get the profile's memory view (frozen at launch), its instructions, read-only `zoom`/`date`, and normal coding tools plus your installed extensions.
- Children also get the Pi built-in extensions the main session loaded: MCP, codemode and tool search. Your MCP servers (`~/.pi/agent/mcp.json`, the project's `.pi/mcp.json`) work in subagents, with the sign-ins you made in Pi. If MCP is off in the main session (`--no-mcp`, `-builtin:mcp` in settings, or an extension that replaces `/mcp`), it is off in subagents too. Each subagent opens its own server connections (stdio servers start once per subagent) and closes them when it ends.
- Each child reports to its parent as soon as it finishes, as one message starting `[id]`. A stopped or failed child reports its stop or error text. Turn **Group subagent reports** on to have the children of one spawn report together: when the last of them finishes, their reports reach the parent as one message, `[id] report` each, in spawn order. Each finished report is journaled right away, so if Pi dies before the rest finish, the reports it already has are delivered at the next start. Messages sent with `tell_parent`, connected windows and their handoffs are never held back, and a child resumed with `tell` reports on its own. The parent stays alive to receive reports; it never polls. A `[OptChat status]` note names currently working agents at the end of a new request; it is not user text. Use `zoom(agent: "id")` to inspect a live or saved agent transcript, in pages.
- In the main chat, subagent messages and reports appear in a dark grey box labelled `↳ subagent <id> · still running` or `· report`, so they don't look like something you typed. The model still receives them as ordinary user messages; memory logs them as kind `work` (older logs hold them as `user` messages starting `[id]`). (One exception: reports recovered at startup, before your first message in the session, still show as plain user messages.)
- The parent can send a running child guidance with `tell`, and the child can message its parent mid-run with `tell_parent` (a question, an early finding). It reaches the parent like a report, marked "still running": between tool calls if the parent is busy, or waking it if it's waiting.
- `tell` to a finished child resumes it: the same agent (ID, parent, model, directory) reopens its saved transcript, gets the message as a new prompt, and sends a new report. This also works for children from earlier Pi sessions. Only the agent that started the child can resume it, and the resumed child takes one active slot. Connected windows can't be resumed, and a child whose transcript is missing must be spawned fresh.
- By default only the main agent starts subagents. Set **Subagent levels** in `/optchat settings` to let them delegate further (3 means child, grandchild, great-grandchild).
- **Max active agents** (8 by default) caps how many agents can be active per profile, including parents waiting on descendants. Going over a limit returns an error; there is no queue.
- Stopping an agent stops its whole subtree. A failed parent stops its descendants.
- Agents run inside the Pi process. Closing Pi stops them; there is no detached mode.

## Recovery safety and operational state

`operational_state` records explicit objectives, decisions, constraints, authorization statements, changes, and checks outside the narrative summary tree. Each record cites an original memory message; authorization and constraint records must exactly quote the entire direct, non-imported user source, never a paraphrase or partial permission. Records do not grant permission, and an implemented change is not a verified check. Updates explicitly supersede earlier entries; evidence references and self-reported assertions remain distinguishable. State is bounded and included in the main request budget rather than silently added after fitting. It is rendered with the view once per turn (and at a mid-turn refresh), so a record made during a turn reaches the model in that call's result and the next turn's view, and the turn's cached run is not written again.

Before an effectful tool runs, OptChat durably records an intent in `operations.json`. Main and child sessions share this journal. An interrupted call with no recorded response, or an error response that cannot rule out partial effects, blocks further effectful calls until reconciliation. Built-in exact-name read tools, trusted installed tools annotated `readOnlyHint: true`, and `operation_state` remain available. Inspect the external state independently, then resolve the operation with an observation evidence reference; never repeat a mutation merely to find out whether it happened. A successful tool response is still **not** proof of an externally verified outcome.

This is conservative recovery, not distributed exactly-once execution or a sandbox: unknown tools (including Code Mode wrappers and most shell commands) are treated as effectful. A small Bash diagnostic grammar recognizes only `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, and `grep`, optionally joined by pipes, `&&`, `||`, or `;`. These read-only calls remain available behind a recovery barrier and do not create uncertain effects on a nonzero exit. Expansions, redirections, escapes, multiline scripts, Git helpers and unrecognized commands remain conservative; a nonzero exit alone never makes a mutation safe. Read-only tool names, shell utilities and author-provided annotations rely on trusted installed definitions, not verified sandbox guarantees. User terminal commands bypass extension hooks. Remote APIs still need their own idempotency keys. Recovery evidence is an explicit agent/operator assertion, not automatically verified by the journal. Raw tool arguments/results are not copied into the operation journal; originals remain in their transcripts.

## Context fidelity and request budgets

For old-topic resumption, exact passage lookup inside a known tree branch, or conflicting historical decisions, use the packaged **optchat-memory** skill. [Resolution-on-demand design, navigation and benchmarks](docs/resolution-on-demand.md) describe bounded reference focus, scoped literal zoom and retrieval-oriented summaries. Originals and chronological tree order remain unchanged; source updates need `/reload`.

Turn refresh keeps live user instructions and custom messages verbatim, including image-bearing tasks, while older executed exchanges move into memory. Tool-result previews stay bounded, but their complete text is persisted and recoverable with paged `zoom`; `zoom(agent)` likewise pages complete child-result text. Child transcripts remain text-only and do not recover image attachments.

Request budgeting uses Pi's estimate of the assembled prompt, active tool schemas, memory and live messages, with the model's output allowance and an additional 5% margin reserved. Existing summary nodes can coarsen the view without deleting originals. If retained instructions still cannot fit, OptChat aborts explicitly rather than silently dropping them. These are conservative estimates, not exact provider tokenizer counts.

### Context performance

Large shell results can reach the model as a deterministic preview with a session-scoped, searchable original (`output_read`); canonical shell evidence and the operation journal stay intact. Storage failure falls back to the original. `/optchat-perf` shows numeric request-size and stage-latency diagnostics without an LLM call, including each tool's own execution time (count, total, average, p50, p90, max per tool name). Focused child history is an opt-in setting, enabled automatically only for a child model whose price rises past a prompt size; such a child also compacts before that size (see `docs/context-performance.md`).

The Agents panel includes an actual `model(thinking)` column (for example `gpt-6-luna(xhigh)`), using effective SDK reasoning levels rather than current profile defaults. [Retention, privacy, offline benchmarks and limitations](docs/context-performance.md).

## Agents, usage and activity inspector

An **Agents | Usage | Activity | Shells** bar sits below the input. **Shells** shows the active count, keeping it visible in a compact layout on narrow terminals.

| Key | Action |
| --- | --- |
| **Down** (empty input) | Focus the bar |
| **Left/Right**, **Enter** | Pick and open a section |
| **Escape**, **Up**, or typing | Back to the editor |
| **F6** | Open Agents directly, keeping your draft |
| **Tab** | Cycle Agents, Usage, Activity and Shells |

Set a different shortcut with `OPTCHAT_INSPECT_KEY=ctrl+shift+a pi`. If another extension supplies a custom editor, OptChat leaves its Down key alone; use the shortcut or commands instead.

**Shells** (`/optchat shells`) lists this session's model-invoked Bash/PowerShell calls, including subagent calls and nested Code Mode calls when Pi emits their execution events. It shows command, state, foreground/background mode and duration; **Enter** opens bounded, scrollable output and the working directory. **End** jumps to the latest output; **Escape** returns to the list. Foreground shells keep their existing Pi/agent interruption controls; inspecting them never cancels a turn.

For explicitly requested background work, the model can use **shell_start** (local Bash), **shell_status** and **shell_stop**. These jobs return immediately and remain inspectable after the turn ends. When one ends, fails, times out or is stopped, OptChat sends the model a single `[shell <id>]` message with its state, exit code, duration, command and the bounded end of its output (the full output path when Bash kept one), between tool calls or as a new turn, so the model never needs to poll; each such report can start one model turn. In the main session, while `shell_start` is active, a `bash` call that waits in the foreground is refused before it runs and the refusal points to `shell_start`: sleeps adding up to 15 s or more, a loop sleeping 10 s or more per pass, `gh run watch` and `gh pr checks --watch`. Shorter readiness pauses still run, a heredoc's body is not read as commands, and subagents (told to poll in short calls) are not affected. `notify` on `shell_start` (default: the profile's **Shell notices** setting) picks which ends are reported: every end, failures only, or none. `alert` is a regular expression: plain text is case-sensitive, and `/pattern/flags` takes the flags `i`, `m`, `s` or `u` (for example `/merged|fail/i`); when a new output line matches, the model gets that line with the two before it, the first match at once and then at most one alert every 10 seconds, with the matches in between counted, so a noisy pattern cannot flood turns. The status line lists running shells next to running agents. Select a running managed job, press **K**, then **Enter** to stop it; **Escape** cancels confirmation. Closing/reloading Pi or changing profiles stops managed jobs via Pi's native process-tree cancellation. History is memory-only, with the latest 50 finished jobs and a bounded output tail. `!`/`!!` commands, external processes and deliberately detached descendants are not tracked; this is not an OS process manager. Commands/output can contain sensitive data: do not share the panel without reviewing it.

**Agents** lists runs as a tree with state, elapsed time, current tool, and last activity. Interrupted runs are resumed when the interactive profile opens again. Navigate with **Up/Down**, **Page Up/Down**, **Home/End**, and press **M** to pick the subagent model.

Runs started by **pi-subagents** appear in the same list, marked with `π`. OptChat reads what pi-subagents already writes (each async run's status file, the live record of a working foreground child, and the saved foreground runs) and shows the run's real agent, model and thinking level, recovered from the run's own session when the saved metadata leaves them out. A run with several steps is one row per step. **Enter** opens that transcript read-only, and while the run is live you can steer it, interrupt it or stop it: an async run is reached through pi-subagents' own control inbox, so it answers from any Pi session, while a foreground child lives in the session that started it and can only be steered or paused from there. **D** twice stops a live `π` run, pauses a foreground child, or hides a finished one from this panel (hiding keeps the run and its artifacts in pi-subagents). OptChat never writes into pi-subagents' run data.

**Enter** swaps the screen to that agent's conversation, drawn with Pi's own chat components, so it reads like the main chat: its task, replies, and collapsed tool calls, following live output. Typing and **Enter** send it guidance. Guidance from the main agent and reports from the agent's own agents show in labelled boxes, so only your own messages look typed. **Escape** goes back to the main chat.

| Key | Action |
| --- | --- |
| **Escape** | Clear a draft, else back to the main chat |
| **Ctrl+C** | Clear a draft, else interrupt the agent's current step. Never ends the agent: queued messages go to it at once and it carries on; with none queued it waits for you (**interrupted · waiting for you**) until your next message, or a `tell` from the main agent, resumes it |
| **Up** (empty input) | Take your newest queued message back to edit; send it again, or clear it to drop it |
| **Ctrl+X** twice | Stop this agent and the agents it started (the only key that ends it) |
| **Page Up/Down**, mouse wheel | Scroll; back at the bottom it follows again. The wheel needs Pi's default fullscreen mode |
| **Ctrl+O** | Expand tool output (Pi's own toggle) |

Guidance shows as queued until delivered, or undelivered if the child stops first. When you interrupt an agent with nothing queued, the agent that started it gets a one-line note instead of a report, so it isn't left waiting. Guidance you send is also saved in main memory. Reasoning is not shown. Transcripts stay browsable after restart, and browsing them makes no model calls.

**Usage** shows this session, last hour, today, last 7 days, or all time (**Left/Right**): one row per role, provider, and model (main agent, subagents, compactor, imports), with an estimated API cost, share of the total, output tokens, and how much input came from the cache. Older records without a provider are labeled `unknown`; sub-cent estimates remain visible.

![Usage page](docs/screenshots/usage.png)

**Activity** is a memory gauge: how many messages the profile holds and how much of the 128 KB view they fill, then either **Settled** or **Catching up · 12 of 40 summaries** with a progress bar counted from when the backlog last grew from empty. If summarizing keeps failing, the last error and the retry countdown show under it. A turn waiting for summaries shows the same error next to its spinner, usually a summarizer model you aren't logged in to (`/optchat model`). Once every summary it waits for has failed, the turn goes on, with "(not summarized yet: zoom it)" in place of the missing lines, and the failed summaries are tried again with your next message. It also counts running agents, and interrupted ones waiting for you; their list is on Agents. While summaries or agents are at work, the bar's Activity item gets a **●**.

![Activity page](docs/screenshots/activity.png)

- Costs are model API-rate estimates, not provider bills. `$0.00` can mean a zero or missing model rate, not confirmed free usage.
- Record counts are not request counts; retries and tool overhead can add records.
- Main-agent tracking starts with v0.3.0 (resumed sessions are backfilled). Older records without a parent session are left out of **This session**.
- All views are limited to the active profile.

## Import history

Pick the destination profile, then run `/optchat import`.

1. **Source**: Claude Code (`~/.claude/projects`), Claude Code memories, Codex (`~/.codex/sessions`, `~/.codex/archived_sessions`), Pi / OMP (`~/.pi/agent/sessions`, `~/.omp/agent/sessions`, and each OMP profile's `~/.omp/profiles/<name>/agent/sessions`; both write the same session format), or a ChatGPT export (ZIP, folder, or `conversations.json`; ZIP needs `unzip`). Scanning is local and makes no model calls.
2. **Select**: for Claude Code, its memories, Codex, and Pi / OMP, pick projects (busiest first), optionally filter by start date, then take all conversations or pick some. **Tab** toggles (and **Space** when the filter is empty), **Enter** continues, type to filter, **Ctrl+A**/**Ctrl+D** select/clear matches, **Esc** cancels. Nothing is classified as work or personal for you.
3. **Mode** (only if the profile already has history):
   - **Append**: keep existing summaries and add the import. Faster and cheaper.
   - **Rebuild by conversation start date**: regenerate the whole tree, ordered by conversation start.
4. **Preview**: destination, new and duplicate counts, text size, rough token estimate, and compactor. This is not a price quote: a big import costs about 3x that estimate in compactor input, because every message is summarized and then re-read in merges, each with the memory view as (mostly cached) context.

**What gets imported**: user messages and final assistant replies, with original dates and source labels, as in Victor's recipe. Tool calls and results, intermediate commentary, reasoning, subagent transcripts, replayed context, and image/audio/file bytes are left out. So is the output Claude Code logs for slash and shell commands; the command itself stays as typed (`/name args` or `!command`). So are the context messages Codex injects, such as the AGENTS.md instructions and the environment context, and the messages OMP injects (reminders, background job notices). Pi / OMP keep `/skill:name args`, `!command` and `$code` as typed, without the skill's text or the output; `!!` and `$$` commands, kept from the model, stay out. Dropped text never becomes a conversation's title. ChatGPT alternate branches are labelled as alternatives, and so are Pi / OMP branches left by a rewind (`[alternate branch]`). Pi sessions that ran under OptChat are skipped: their messages are already in a profile's memory. A forked session adds only its new messages. Imported records are marked as historical so old requests are not treated as new instructions.

**Claude Code memories**: the auto-memory topic files in `~/.claude/projects/*/memory/` (not `MEMORY.md`, which only indexes them), picked by project. Each file becomes one dated note in the memory tree, not part of the prompt. An edited file comes in again as a newer note.

**Duplicates**: re-importing skips messages already present, even if titles or paths changed. A resumed Claude Code session copies earlier messages into its own file; those copies are matched by message id and text, so they come in once, also against messages an earlier import stored. Changed source messages can appear as a separate historical version.

**Pausing**: **Pause import** (or Escape) saves progress, and so does restarting Pi. `/optchat import` then offers **Resume** or **Discard staged import**. While an import is pending, chat in that profile is blocked; other profiles still work. Imports need the main agent and its subagents to be idle.

**Safety**: imports build a new memory generation and switch to it only when the whole tree is ready. The previous generation stays on disk. Source files are never modified.

Damaged or unsupported records are listed before you start, so you can cancel or continue without them. Conversations that disappear during the scan are skipped with a warning.

See OpenAI's guides on [exporting ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) and the [conversation file format](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts).

## Connected windows

Each profile is locked to one Pi process. If you open the same profile in a second terminal, Pi offers to connect it to the original window as a subagent, or to go back to the profile picker.

- Your first message starts a subagent in the second window's working directory. Later messages continue the same conversation.
- The window looks like a normal Pi chat: replies, tool calls with their output and running time, the working spinner, and reports from the subagent's own agents in the dark box. Ctrl+O expands tool output.
- The subagent runs inside the original process, which stays the only writer of memory. It appears in the original window's inspector and uses one of the 8 agent slots. While it is open, the original window can't switch profile or import.
- The main agent is told when the conversation starts. Use `/tell-main <message>` to message it yourself; the subagent can use `tell_parent`, and the main agent replies with `tell`. Routine turns don't wake the main agent.
- Run `/complete` when done. The window closes, remaining work stops, and the compactor writes a handoff for the main agent: decisions, changes, evidence, failures, unfinished work, and links to the transcripts.
- Closing or force-quitting the window also produces a handoff, marked **interrupted**.
- If the original window is closed cleanly, handoffs are delivered on next start. If it is killed, reopening the profile recovers unfinished handoffs (work is not restarted).
- Text only. For images, give the agent a file path.
- The connection is a local socket restricted to your OS user (on Windows, a named pipe with its default access rules). No daemon or server.

Handoff limits: the whole transcript is summarized in one call if it fits in about 128,000 input tokens (estimated at 4 bytes per token; less on smaller models), otherwise in chunks. Output is up to 16,000 tokens, with a 5-minute timeout per call. If summarizing fails, a labelled fallback still reports the task, last result, and transcript locations.

## Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`):

| Path | Contents |
| --- | --- |
| `main/` | The conversation log (dated JSONL, no reasoning) |
| `tree/` | Summary nodes |
| `active-memory.json`, `memories/<id>/` | After an import: pointer to the active `main/` and `tree/`. Older generations are kept. |
| `imports/pending.json` | Resumable import state |
| `AGENTS.md` | Profile instructions |
| `config.json` | Compactor and subagent models, their per-provider fallbacks, settings |
| `pending-inputs.json`, `pending-reports.json` | Recovery journals |
| `runs/` | Subagent sessions and run metadata |
| `usage.jsonl` | Usage ledger, append-only; the only copy of each record |
| `usage.db` | Disposable SQLite index of `usage.jsonl` (Node's `node:sqlite`): opening reads only new lines and the usage page sums hourly totals. Delete it any time; it is rebuilt from the ledger. Without `node:sqlite` the ledger is read in full. Excluded from memory Git checkpoints |
| `operational-state.json` | Bounded structured facts, evidence references and supersession history |
| `operations.json` | Tool intents, observed responses and recovery reconciliation (not proof of external success) |
| `recovery-diagnostics.jsonl` | Rotating metadata-only recovery incidents, excluded from memory Git checkpoints |
| `cache-diagnostics.jsonl` | One line per main Anthropic request: view blocks, marks, time since the last request, and where the view first differs from the last request's (`changedAt`: a block index for a rewrite, `null` when it only grew; `headChanged` for system/tools/model). Joined to `usage.jsonl` by date, it tells a cache miss's cause. Rotating at 1 MB, no message text, excluded from memory Git checkpoints |
| `cache-entries.json` | The view blocks earlier requests marked (digests, TTLs) and the last request's view digests, rewritten each main Anthropic request, so after `/reload` the first request still marks an entry the cache holds instead of writing the view again. No message text, excluded from memory Git checkpoints |
| `memory.html` | Snapshot from `/optchat browse` |

Each profile folder is a local Git repository, committed after each turn and on clean shutdown (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

To delete a profile, delete its folder. Your original Pi sessions are kept in Pi's normal session directory.

## Good to know

- **Profiles separate memory and instructions only.** Agents keep full filesystem access and share provider credentials.
- **Tab title**: the terminal tab shows the profile and what it is doing: `π personal` while waiting for you, `● π personal` while the agent works, plus `· 2 agents` while subagents run. A connected window shows `↳ personal`, `● ↳ personal`, then `↳ personal · done` or `↳ personal · disconnected`. OptChat replaces Pi's default title and puts its own back when Pi resets it (new session, reload, rename).
- **Use worktrees** when parallel agents edit the same repository; they share the filesystem.
- **Instructions**: the main agent and subagents get Pi's usual global and repository `AGENTS.md` files and your skills, followed by the profile's `AGENTS.md`, which comes last and wins. OptChat replaces only Pi's opening prompt. Prompt templates work in the main session only.
- **Images** you paste, or a tool returns, are kept in the profile's memory folder under `images/` (once each, shrunk to 2,048 px on the long side and about 1.5 MB with Pi's own resizer; smaller ones stay as they are). The log names each as `[image <hash>]`, and `zoom(id, 1)` returns a message's images with its text, so the agent can look again in a later turn. Summaries stay text. Imported conversations keep a text placeholder.
- **Long runs**: Pi's auto-compaction is off for the main agent. Once the current run passes the **Turn refresh threshold** (30% of the model's context window by default), completed exchanges move into memory and the turn continues with a fresh window. The task and last whole tool exchange remain verbatim; earlier steps stay available through `zoom`. `OPTCHAT_REFRESH_AT` (a fraction, such as `0.3`; `0` disables refresh) overrides the profile setting. Subagents use Pi's own compaction at about the same point.
- **Restarts**: unsent inputs are recovered into memory, and pending subagent reports are delivered. Interrupted subagents are not restarted.
- **Prompt-template inputs** can be saved twice: expanded, and later in their original form as an unanswered input, because Pi expands them after the input journal records them. Skill commands (`/skill:name`) are matched back to their journaled input and don't have this problem. Plain text chat is unaffected.

## How it follows the recipe

OptChat follows [Victor Taelin's recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) (the 2026-10-08 revision) by default:

- **The log**: append-only and flushed at each write, one owner per profile, no thoughts, tool output clipped to 30,000 characters (head and tail). A longer text is never cut: it is logged as several messages in a row, 25,000 characters each, so every one opens whole with `zoom(id, 1)`.
- **The tree**: nodes target 512 bytes (a shrinking fallback can be larger); a source that fits is its own node without a model call, each node built once and logged.
- **The view**: `id+n|text` lines without dates. It grows a line per message and, past 128,000 bytes, merges its most due pairs (`(T - last) / 2^l`, oldest first among equals, only pairs whose parent is built) in one batch down to 64,000. The batch rewrites the view from near its top, so the chat puts it off while the prompt cache is warm: it runs when a turn starts 4.5 minutes or more after the last request (an hour on Anthropic's API, where the view's older mark keeps its prompt an hour), or once the view passes 192,000 bytes. It is saved to `view.json` and loaded at start, never rebuilt.
- **One prompt**: `src/recipe-prompt.ts` holds the recipe's system prompt for turns and compactions, verbatim but for the agent's name, its kinds (`talk` for replies, reports starting "[id] "), `zoom(agent: "id")` for the recipe's `zoom("Name")`, and no paragraph on computers. Your instructions follow it.
- **Turns**: a turn waits for the summaries before it, renders the view before logging your message, and starts from a fresh context: nothing carries over. Per-turn state (the working directory) goes after the view, not in the system prompt.
- **Compactions**: a call like a turn, with the turns' system prompt and tools (never called) once a turn has built them, then its own view (the chat's merged further, to 16,000-32,000 bytes, ending at the node and stopping at the first line not built yet) and the recipe's task with its 512-dash ruler and a UTF-8 safety target. An oversized line gets measured correction feedback, including the real source-bound limit, for up to 5 tries. The shortest complete shrinking reply is then kept, even above the target; actual bytes count toward the view budget. Partial or non-shrinking replies are rejected. Nothing is silently truncated. Up to 8 run at once; a message's node starts once fewer than 8 lines before it are unbuilt; ready nodes are queued, never searched for. A failed call is retried twice with backoff when it fails before a response (see Long runs and compactor diagnostics), then again at the next message.
- **The cache** (Anthropic): the view in blocks of 4 lines, a mark on the last whole block and one at the request's end, 5-minute entries, and on the main agent and subagents the system prompt and the view's older mark take 1-hour entries (one hour on Anthropic's API, the 5-minute default elsewhere); no keep-alive pings; one compaction primes a cold prefix and the others wait until its response starts.
- **Subagents**: a fresh call whose first message is the view, then its task; its steps stay in its own log (`zoom(agent: "id")`), and its final reply comes back as one `work` message. The main agent never waits or polls.

Where it still differs:

1. **Settings** turn on what the recipe leaves out, all off by default: Previous exchange (your last request and its answer replayed in full with the next turn, left out over the limit), Memory search (a `search` tool over the original messages), a Summary size tolerance above 512 bytes, and Group subagent reports.
2. **Two more cache marks**, 20 and 40 blocks before the last whole one: Anthropic looks back only 20 blocks from a mark, so with the recipe's single view mark a turn that added more than 80 lines of tool calls made the next turn rewrite the whole view. When the view grows further than those marks reach (a long turn folded in, or moved into memory mid-turn), the older mark goes back on the newest block an earlier call marked whose entry is still alive and unchanged, so that entry is read instead of the view being written again. Only marks that left an entry count: Anthropic writes none at a mark before the entry a request reads, which for every call after a turn's first is the last request's end.
3. **Subagents have their own system prompt** (`src/prompts.ts`), and are built in with Pi's SDK. With Subagent levels above 1 they can delegate further.
4. **Pi's own prompt sections** (your global and repository `AGENTS.md` files and skills) stay in the system prompt, before the profile's instructions.
5. **Imports, profiles, the inspector, the usage ledger, images and connected windows** are additions. An import logs each imported message whole, adds historical-record guidance to its compactions, and retries a failed summary after 10 seconds, since no next message comes to retry it.
6. **A message's compaction task names its kind** ("compress message 6, kind echo, ...") and says to summarize `<input>` alone: Haiku sometimes folded the `<chat>` lines before a message into its summary, under the wrong kind. The code then sets the summary's `kind:` head itself, replacing any the model wrote.
7. **A tool call is summarized with its result**: its summary waits until the call's result is logged (or a turn needs every line) and the task shows the result, capped at 12,000 characters, so the line says what the call found instead of "output unseen".
8. **Blocks start on their own paragraph**: the working directory, your message and a compaction's task begin with a blank line, because some providers (OpenAI's Responses API) join a message's text blocks with nothing between them (`</chat>Working directory: C:/Users/youok ...`).
9. **`zoom(id, 1)` answers under `id+1|`**, the line it opens, as the view would show it.
10. **The system prompt and tools stay as their cache entry was written**: a tool enabled mid-session (`web_enable`, a goal's tools) or an edited `AGENTS.md` section is sent after the view as one of Pi's native system messages (`tool_addition`, `tool_removal`, section update) on models that take later system messages (Claude and the GPT-6 Codex models; on Codex an added tool is an anchored `additional_tools` item, and a withdrawn one makes Pi send the current tool list), instead of rewriting the whole request. The head is rebuilt when its entry is gone anyway (cold cache, another model) or a prompt change is not a section update.
11. **Not done**: computer use and hosting on an always-on machine.

See `docs/victor-recipe.md` for the mapping to the source files.

## Development

```sh
git clone https://github.com/lennix1337/pi-optchat.git
cd pi-optchat
npm ci --ignore-scripts
pi install .
```

Restart Pi after source changes. Use `OPTCHAT_HOME` to test against a throwaway data directory.

```sh
npm run check      # type check
npm test           # offline tests, no paid model calls
npm run test:pi-compat # real Pi runtime compatibility checks, no paid model calls
npm run test:live  # paid Anthropic calls on synthetic data in a disposable profile
```

### Offline reliability and overhead

`npm run test:reliability` checks replay barriers, receipt metadata, output preservation and diagnostic exposure. `npm run benchmark:reliability -- <preserved-baseline-root>` compares repeated-output projection and fresh-process imports without providers or credentials. Without a baseline it is only a current/current smoke. Keep reports/baselines outside Git. `/optchat-perf payload on` enables numeric-only pre-provider payload byte measurements for this session; `payload off` disables their serialization overhead (default off). No instructions/history are deduplicated or removed. [Results and limits](docs/reliability-performance.md).

### Agent latency benchmark

`npm run benchmark:agents` makes real provider calls using synthetic tasks in a disposable
profile under ignored `scratchpad/`; it never reads your chat or edits project files.
It defaults to `openai-codex/gpt-6-luna`, comparing `medium` and `xhigh` in alternating
order. Override with `BENCH_PROVIDER`, `BENCH_MODEL`, and `BENCH_REPEATS` (1–10, default 2).
It uses your provider credentials and quota; run it explicitly, not in CI.

Set `BENCH_TASK=coding` to repair a seeded invoice module against immutable regression
tests. Coding trials verify the test file is unchanged and run the tests independently;
invalid trials fail the benchmark rather than counting as speed improvements.

Results are written to `scratchpad/agent-benchmark-<task>-results.json`. Each sample checks
completion state and either JSON output or passing regression tests, recording memory settling, view rendering,
session opening, first assistant activity, execution, and overall latency. First activity
is not necessarily a visible token. Failed samples remain in the results and fail the run.
Optional `Children` timing callbacks contain only phase names, IDs, durations, and prompt
lengths—not prompts or tool contents—and callback failures do not interrupt execution.

This small no-tool task measures startup and model overhead, not coding throughput.
Compare repeated samples and quality before drawing conclusions; a single pair, cold
startup, and provider caching can be misleading. The seeded coding workload is still synthetic,
not evidence of production coding throughput. Delete benchmark results when no longer needed.

### Upstream npm publishing

The retained workflow below describes upstream's npm release setup. This fork is installed from GitHub; its commits are not automatically published as `npm:pi-optchat`. Do not assume upstream's npm trusted-publishing authorization applies to this repository.

Pi's [package directory](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) lists npm packages with the `pi-package` keyword, which the manifest already has. GitHub alone is not enough.

Publishing a GitHub release publishes to npm. The [Publish workflow](.github/workflows/publish.yml) uses npm trusted publishing, so no token or `npm login` is involved:

1. Merge a PR that bumps `version` in `package.json`.
2. `gh release create vX.Y.Z --target main --generate-notes`

The workflow checks that the tag matches `package.json`, runs the type check and tests, and publishes with provenance. It skips versions already on npm. To retry a tag, run it by hand: `gh workflow run publish.yml -f tag=vX.Y.Z`.

## Credits and license

Forked from [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat), with additional development by [lennix1337](https://github.com/lennix1337).

Based on [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) and [OptMem](https://github.com/VictorTaelin/OptMem). His revised gist (2026-10-08) calls his own version UniiChat. This is an independent Pi implementation, not Victor's official OptChat.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
