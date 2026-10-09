![Pi-OptChat: persistent memory for Pi](https://raw.githubusercontent.com/jonaslsaa/pi-optchat/main/docs/banner.jpg)

# pi-optchat

A Pi extension that implements [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one endless chat per profile, remembered through a summary tree instead of compaction.

- **Memory**: every message is logged and summarized into a binary tree. Each turn starts from a fresh context holding a bounded memory view; the agent uses `zoom` and `date` to read originals.
- **Profiles**: separate memories and instructions, such as `work` and `personal`.
- **Subagents**: delegate tasks to background agents, inspect them live, and send them guidance.
- **Import**: bring in history from Claude Code (conversations and memories), Codex, Pi and [OMP](https://github.com/can1357/oh-my-pi), or ChatGPT.
- **Connected windows**: a second Pi window on the same profile becomes a subagent you talk to directly.

It runs inside ordinary Pi, with no fork or separate launcher.

## Install

```sh
pi install npm:pi-optchat
pi install npm:pi-web-access   # optional, for web search and page fetching
```

Or from GitHub: `pi install git:github.com/jonaslsaa/pi-optchat`.

Requirements: Pi 1.0.2 or compatible, Node.js 22.19+, and Git. Tested on macOS; the offline tests also run on Linux and Windows.

Windows is supported natively, without WSL: install and start Pi as usual. There the profile lock and the connected-window channel are named pipes instead of socket files in the profile folder. Live use on Windows has so far covered headless memory (`pi -p --optchat-profile`); the interactive screens, connected windows and imports are covered by the offline tests only.

Web access is not bundled. Subagents load the Pi extensions you have installed (except pi-optchat itself), so installing `pi-web-access` gives web tools to the main agent and every subagent.

To uninstall, run `pi remove git:github.com/jonaslsaa/pi-optchat`. Profile data is kept.

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
| `/optchat settings` | This profile's settings: models, subagent levels and limits, previous exchange, summary size tolerance. |
| `/optchat model` | Compactor model and effort for this profile. Type to filter the models you are logged in to; the current one is marked. |
| `/optchat fallback` | Per-provider models for the compactor: what it runs while the main model is on another provider. `/optchat agents fallback` does the same for subagents. |
| `/optchat agents` | Live agent tree and saved run history. |
| `/optchat agents model` | Subagent model and effort for this profile, picked the same way. |
| `/optchat usage` | Token usage and cost estimates. |
| `/optchat activity` | Memory gauge: view size, summaries catching up, running agents. |
| `/optchat instructions` | Edit this profile's `AGENTS.md`. |
| `/optchat browse` | Open a readable snapshot of memory: the shape of what the model sees, summaries you can open down to the original messages, and search that shows where each message is folded. Run again to refresh. |
| `/optchat import` | Import history, or resume/discard a paused import. |
| `/complete` | In a connected window: end the conversation and hand off to the main agent. |
| `/tell-main <message>` | In a connected window: message the main agent. |

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

A long execution refreshes its context from the **same memory tree**, between complete tool exchanges, when its active transcript exceeds 128 KB or approaches the selected model's input budget. Original messages are logged first. Live user instructions and the last complete assistant/tool exchange remain exact; older executed exchanges stay available through `zoom`. This changes neither the tree algorithm nor its 128/64 KB view and 512-byte summaries.

Pi's automatic or manual compaction stores a snapshot of that existing view, with Pi's safe transcript boundary; it does not call a second summarizer or normally cancel compaction. Unbound Pi sessions retain Pi's own policy. A refresh refuses to drop unsummarized results if the compactor is failing. An input or retained exchange that cannot fit requires a smaller input or larger-context model, rather than silently losing data. Token checks use provider usage when available and Pi's size estimate otherwise, not an exact tokenizer.

Compactors keep the turns' system prompt and tool schemas for caching, but request `toolChoice: none`. Empty replies, tool calls and truncated responses are rejected, not saved as summaries. Failed nodes still retry on the next message, as in the recipe; no model/effort switch or immediate retry loop is added.

Each attempt writes safe metadata to `<profile>/compactor-diagnostics.jsonl`: node, provider/model/API, requested/effective effort, duration, request sizes, event counts, HTTP status/request ID when available, native response status/ID, incomplete/error code, native content types/text byte counts, normalized stop reason, response block types/lengths and token usage. Native text bytes versus parsed text bytes help distinguish empty provider output from dropped SDK text. Exceptions are categorized, not copied into this log. No prompts, message/summary text, reasoning text, tool arguments, authorization headers or tokens are recorded. Two rotating files are bounded to approximately 1 MB each and excluded from memory Git checkpoints.

If `Compactor returned no text` recurs, keep the matching diagnostic row (node and timestamp); an HTTP 200 alone does not prove a usable summary. The intermittent historical Luna failures have not been reproduced in controlled live tests, so their cause is not yet established.

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
| Summary size tolerance | 512 bytes | The compactor is always asked for 512-byte lines; a longer line up to this size is kept instead of retried. 512 is the recipe's strict rule. |

Numbers must be whole numbers of at least 1 (512 for the summary size tolerance). Missing keys in an older `config.json` take their defaults.

**Upgrading from 0.6.x:** subagent levels used to be fixed at 3 and now default to 1, so subagents no longer start their own subagents until you set Subagent levels to 2 or 3.

![Settings page](docs/screenshots/settings.png)

## Subagents

Ask in plain words, for example: "Spawn an agent to investigate this repository and report back."

- Children get the profile's memory view (frozen at launch), its instructions, read-only `zoom`/`date`, and normal coding tools plus your installed extensions.
- Children also get the Pi built-in extensions the main session loaded: MCP, codemode and tool search. Your MCP servers (`~/.pi/agent/mcp.json`, the project's `.pi/mcp.json`) work in subagents, with the sign-ins you made in Pi. If MCP is off in the main session (`--no-mcp`, `-builtin:mcp` in settings, or an extension that replaces `/mcp`), it is off in subagents too. Each subagent opens its own server connections (stdio servers start once per subagent) and closes them when it ends.
- Each child reports to its parent as soon as it finishes, as one message starting `[id]`. A stopped or failed child reports its stop or error text. Turn **Group subagent reports** on to have the children of one spawn report together: when the last of them finishes, their reports reach the parent as one message, `[id] report` each, in spawn order. Each finished report is journaled right away, so if Pi dies before the rest finish, the reports it already has are delivered at the next start. Messages sent with `tell_parent`, connected windows and their handoffs are never held back, and a child resumed with `tell` reports on its own. The parent stays alive to receive reports; it never polls.
- In the main chat, subagent messages and reports appear in a dark grey box labelled `↳ subagent <id> · still running` or `· report`, so they don't look like something you typed. The model still receives them as ordinary user messages; memory logs them as kind `work` (older logs hold them as `user` messages starting `[id]`). (One exception: reports recovered at startup, before your first message in the session, still show as plain user messages.)
- The parent can send a running child guidance with `tell`, and the child can message its parent mid-run with `tell_parent` (a question, an early finding). It reaches the parent like a report, marked "still running": between tool calls if the parent is busy, or waking it if it's waiting.
- `tell` to a finished child resumes it: the same agent (ID, parent, model, directory) reopens its saved transcript, gets the message as a new prompt, and sends a new report. This also works for children from earlier Pi sessions. Only the agent that started the child can resume it, and the resumed child takes one active slot. Connected windows can't be resumed, and a child whose transcript is missing must be spawned fresh.
- By default only the main agent starts subagents. Set **Subagent levels** in `/optchat settings` to let them delegate further (3 means child, grandchild, great-grandchild).
- **Max active agents** (8 by default) caps how many agents can be active per profile, including parents waiting on descendants. Going over a limit returns an error; there is no queue.
- Stopping an agent stops its whole subtree. A failed parent stops its descendants.
- Agents run inside the Pi process. Closing Pi stops them; there is no detached mode.

## Agents, usage and activity inspector

An **Agents | Usage | Activity** bar sits below the input.

| Key | Action |
| --- | --- |
| **Down** (empty input) | Focus the bar |
| **Left/Right**, **Enter** | Pick and open a section |
| **Escape**, **Up**, or typing | Back to the editor |
| **F6** | Open Agents directly, keeping your draft |
| **Tab** | Cycle Agents, Usage and Activity |

Set a different shortcut with `OPTCHAT_INSPECT_KEY=ctrl+shift+a pi`. If another extension supplies a custom editor, OptChat leaves its Down key alone; use the shortcut or commands instead.

**Agents** lists runs as a tree with state, elapsed time, current tool, and last activity. Navigate with **Up/Down**, **Page Up/Down**, **Home/End**, and press **M** to pick the subagent model.

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

**Usage** shows this session, last hour, today, last 7 days, or all time (**Left/Right**): one row per role and model (main agent, subagents, compactor, imports) with estimated cost, share of the total, output tokens, and how much input came from the cache. Costs are API prices, not your subscription bill.

![Usage page](docs/screenshots/usage.png)

**Activity** is a memory gauge: how many messages the profile holds and how much of the 128 KB view they fill, then either **Settled** or **Catching up · 12 of 40 summaries** with a progress bar counted from when the backlog last grew from empty. If summarizing keeps failing, the last error and the retry countdown show under it. A turn waiting for summaries shows the same error next to its spinner, usually a summarizer model you aren't logged in to (`/optchat model`). Once every summary it waits for has failed, the turn goes on, with "(not summarized yet: zoom it)" in place of the missing lines, and the failed summaries are tried again with your next message. It also counts running agents, and interrupted ones waiting for you; their list is on Agents. While summaries or agents are at work, the bar's Activity item gets a **●**.

![Activity page](docs/screenshots/activity.png)

- Costs are API-rate estimates, not your subscription bill. Unknown rates show zero.
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
| `usage.jsonl` | Usage ledger |
| `memory.html` | Snapshot from `/optchat browse` |

Each profile folder is a local Git repository, committed after each turn and on clean shutdown (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

To delete a profile, delete its folder. Your original Pi sessions are kept in Pi's normal session directory.

## Good to know

- **Profiles separate memory and instructions only.** Agents keep full filesystem access and share provider credentials.
- **Tab title**: the terminal tab shows the profile and what it is doing: `π personal` while waiting for you, `● π personal` while the agent works, plus `· 2 agents` while subagents run. A connected window shows `↳ personal`, `● ↳ personal`, then `↳ personal · done` or `↳ personal · disconnected`. OptChat replaces Pi's default title and puts its own back when Pi resets it (new session, reload, rename).
- **Use worktrees** when parallel agents edit the same repository; they share the filesystem.
- **Instructions**: the main agent and subagents get Pi's usual global and repository `AGENTS.md` files and your skills, followed by the profile's `AGENTS.md`, which comes last and wins. OptChat replaces only Pi's opening prompt. Prompt templates work in the main session only.
- **Images** you paste, or a tool returns, are kept in the profile's memory folder under `images/` (once each, shrunk to 2,048 px on the long side and about 1.5 MB with Pi's own resizer; smaller ones stay as they are). The log names each as `[image <hash>]`, and `zoom(id, 1)` returns a message's images with its text, so the agent can look again in a later turn. Summaries stay text. Imported conversations keep a text placeholder.
- **Pi's auto-compaction is off.** A single very long run can still hit the model's context limit; stop it and continue in a new turn.
- **Restarts**: unsent inputs are recovered into memory, and pending subagent reports are delivered. Interrupted subagents are not restarted.
- **Prompt-template inputs** can be saved twice: expanded, and later in their original form as an unanswered input, because Pi expands them after the input journal records them. Skill commands (`/skill:name`) are matched back to their journaled input and don't have this problem. Plain text chat is unaffected.

## How it follows the recipe

OptChat follows [Victor Taelin's recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) (the 2026-10-08 revision) by default:

- **The log**: append-only and flushed at each write, one owner per profile, no thoughts, tool output clipped to 30,000 characters (head and tail). A longer text is never cut: it is logged as several messages in a row, 25,000 characters each, so every one opens whole with `zoom(id, 1)`.
- **The tree**: 512-byte nodes, a source that fits is its own node without a model call, each node built once and logged.
- **The view**: `id+n|text` lines without dates. It grows a line per message and, past 128,000 bytes, merges its most due pairs (`(T - last) / 2^l`, oldest first among equals, only pairs whose parent is built) in one batch down to 64,000. It is saved to `view.json` and loaded at start, never rebuilt.
- **One prompt**: `src/recipe-prompt.ts` holds the recipe's system prompt for turns and compactions, verbatim but for the agent's name, its kinds (`talk` for replies, reports starting "[id] "), `zoom(agent: "id")` for the recipe's `zoom("Name")`, and no paragraph on computers. Your instructions follow it.
- **Turns**: a turn waits for the summaries before it, renders the view before logging your message, and starts from a fresh context: nothing carries over. Per-turn state (the working directory) goes after the view, not in the system prompt.
- **Compactions**: a call like a turn, with the turns' system prompt and tools (never called) once a turn has built them, then its own view (the chat's merged further, to 16,000-32,000 bytes, ending at the node and stopping at the first line not built yet) and the recipe's task, verbatim, with its 512-dash ruler. A line over 512 bytes gets the recipe's "Too long" retry, up to 5 tries, keeping the shortest. Up to 8 run at once; a message's node starts once fewer than 8 lines before it are unbuilt; ready nodes are queued, never searched for. A failed call is tried again at the next message.
- **The cache** (Anthropic): the view in blocks of 4 lines, a mark on the last whole block and one at the request's end, 5-minute entries, no keep-alive pings; one compaction primes a cold prefix and the others wait until its response starts.
- **Subagents**: a fresh call whose first message is the view, then its task; its steps stay in its own log (`zoom(agent: "id")`), and its final reply comes back as one `work` message. The main agent never waits or polls.

Where it still differs:

1. **Settings** turn on what the recipe leaves out, all off by default: Previous exchange (your last request and its answer replayed in full with the next turn, left out over the limit), Memory search (a `search` tool over the original messages), a Summary size tolerance above 512 bytes, and Group subagent reports.
2. **Two more cache marks**, 20 and 40 blocks before the last whole one: Anthropic looks back only 20 blocks from a mark, so with the recipe's single view mark a turn that added more than 80 lines of tool calls made the next turn rewrite the whole view.
3. **Subagents have their own system prompt** (`src/prompts.ts`), and are built in with Pi's SDK. With Subagent levels above 1 they can delegate further.
4. **Pi's own prompt sections** (your global and repository `AGENTS.md` files and skills) stay in the system prompt, before the profile's instructions.
5. **Imports, profiles, the inspector, the usage ledger, images and connected windows** are additions. An import logs each imported message whole, adds historical-record guidance to its compactions, and retries a failed summary after 10 seconds, since no next message comes to retry it.
6. **A message's compaction task names its kind** ("compress message 6, kind echo, ...") and says to summarize `<input>` alone: Haiku sometimes folded the `<chat>` lines before a message into its summary, under the wrong kind. The code then sets the summary's `kind:` head itself, replacing any the model wrote.
7. **A tool call is summarized with its result**: its summary waits until the call's result is logged (or a turn needs every line) and the task shows the result, capped at 12,000 characters, so the line says what the call found instead of "output unseen".
8. **Blocks start on their own paragraph**: the working directory, your message and a compaction's task begin with a blank line, because some providers (OpenAI's Responses API) join a message's text blocks with nothing between them (`</chat>Working directory: C:/Users/youok ...`).
9. **`zoom(id, 1)` answers under `id+1|`**, the line it opens, as the view would show it.
10. **Not done**: computer use and hosting on an always-on machine.

See `docs/victor-recipe.md` for the mapping to the source files.

## Development

```sh
git clone https://github.com/jonaslsaa/pi-optchat.git
cd pi-optchat
npm ci --ignore-scripts
pi install .
```

Restart Pi after source changes. Use `OPTCHAT_HOME` to test against a throwaway data directory.

```sh
npm run check      # type check
npm test           # offline tests, no paid model calls
npm run test:live  # paid Anthropic calls on synthetic data in a disposable profile
```

### Publishing to npm

Pi's [package directory](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) lists npm packages with the `pi-package` keyword, which the manifest already has. GitHub alone is not enough.

Publishing a GitHub release publishes to npm. The [Publish workflow](.github/workflows/publish.yml) uses npm trusted publishing, so no token or `npm login` is involved:

1. Merge a PR that bumps `version` in `package.json`.
2. `gh release create vX.Y.Z --target main --generate-notes`

The workflow checks that the tag matches `package.json`, runs the type check and tests, and publishes with provenance. It skips versions already on npm. To retry a tag, run it by hand: `gh workflow run publish.yml -f tag=vX.Y.Z`.

## Credits and license

Based on [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) and [OptMem](https://github.com/VictorTaelin/OptMem). His revised gist (2026-10-08) calls his own version UniiChat. This is an independent Pi implementation, not Victor's official OptChat.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
