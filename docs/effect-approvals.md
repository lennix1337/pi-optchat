# Exact-invocation effect approvals (opt-in)

For authorization refusals and activation, use the packaged `effect-approvals` skill.
This boundary prevents accidental unapproved **tool dispatch**. It is not a security
sandbox for installed plugins, repository code, the SDK, or an adversarial model.

## Modes

- `OPTCHAT_EFFECT_APPROVALS=1` (**all**): every non-diagnostic call needs an exact approval, edits included.
- `OPTCHAT_EFFECT_APPROVALS=risk`: ordinary work runs; only these classes need one, matched in
  `bash`/`shell_start` commands and `codemode` script text:
  - **push**: any `git ... push`;
  - **publish**: `npm`/`pnpm`/`yarn`/`cargo`/`vsce publish`, `gh release create`, `gh pr merge`, `gh repo create|delete`;
  - **global install**: `npm|pnpm|yarn i|install|add|link -g|--global`, `cargo|winget|choco|scoop install`;
  - **recursive delete** (`rm -r`, `Remove-Item -Recurse`, `rd /s`) unless every target is in a temp folder (`C:/tmp`, `/tmp`, `$TMP`, `%TEMP%`);
  - **discard**: `git reset --hard`, `git clean -f`, `git worktree remove --force`, `git branch -D`, `git stash drop|clear`;
  - **paid model call**: `subagent`/`spawn`/`tell` (except `subagent` list/models/guide/status/validate), `pi -p|--print`, `bench.mjs run`, codemode `models.*` or `tools.subagent|spawn|tell`;
  - **production write**: an `ssh` command that also writes SQL (`update ... set`, `insert into`, `delete from`, `drop`, `truncate`, `alter table`) or changes remote containers or services (`docker restart|rm|stop|compose up`, `systemctl restart`, `kubectl apply`...); reads over ssh pass;
  - **deploy**: running a `deploy*.ps1|sh|mjs` script (not with `-PlanOnly`/`-WhatIf`/`--dry-run`), `wrangler|fly|netlify|railway deploy`, `vercel --prod`, `gh workflow run` of a deploy/release workflow, `docker push`, `kubectl apply|rollout`;
  - **autonomy contract change**: any non-read call whose arguments name `autonomy.json`.

  Risk mode is a guardrail against accidental high-impact effects: a command that hides its
  verb (variables, `eval`, encoded scripts, a script file that pushes) is not recognized, and
  MCP tools are not classified. Use `1` when that boundary matters. Standing grants work in both modes.

## Autonomy contract (`autonomy.json`)

A profile may hold `autonomy.json`: the operator's standing decisions on which high-impact effects
the agent runs alone, runs and reports, or always brings to the operator. It is read from the call
itself, never from the conversation, so a misread "sim" cannot widen it.

```json
{ "version": 1, "default": "ask", "rules": [
  { "action": "push", "scope": ["lennix1337/*"], "level": "free", "note": "branches and PRs" },
  { "action": "push-main", "scope": ["lennix1337/pi-*"], "level": "report" },
  { "action": "merge", "scope": ["tecnologia-ai/*"], "level": "ask", "until": "2027-01-01T00:00:00Z" }
] }
```

- **Actions** (`src/effect-classifier.ts`): `push` (a branch), `push-main` (`main`/`master`, by refspec or by the
  checked-out branch), `force-push`, `merge` (`gh pr merge`), `publish` (package publish, `gh release create`,
  `gh repo create|delete`, `release.ps1`/`publish.ps1`), `deploy`, `production-write`, `paid` (targets `subagent`
  or `model-run`; a local script whose source builds a model runtime or provider client counts as `model-run`),
  `discard` (hard reset, forced clean, branch -D, remote branch delete, `Invoke-PcMaintenance|WorktreeCleanup -Apply`
  with targets `pc-maintenance` / `worktree-cleanup`), `recursive-delete`, `global-install`; `*` matches any.
- **Targets**: the working folder (`git -C`, the last `cd`, else cwd; lowercase, forward slashes), the GitHub
  `owner/repo` of the remote it uses (`--repo`/`-R`, the pushed remote, else `origin`, read with local git), or
  `ssh:<host>`. `scope` patterns use `*` as a wildcard; `*` alone matches everything.
- **Levels**: `free` runs; `report` runs and appends `{ at, action, targets, summary, rule }` to
  `autonomy-log.jsonl` in the profile with an info notice; `ask` waits for `/approve` and skips the advisor.
- **Order**: the first live rule (unexpired `until`) whose action and scope match decides; a call with several
  effects takes the strictest (`ask` > no rule > `report` > `free`). An effect with no rule uses `default`
  (`advisor`, the default, keeps the advisor below; or a level).
- **Typed orders**: an `ask` on `merge`, `deploy` or `publish` runs (and is logged to `autonomy-log.jsonl` as
  `operator order <message id>`) when the operator's own message ordered it: an `operational_state` authorization
  quoting that message whole, with a grant for that action whose scope covers a target. All of these must hold
  (`orderGrantFor` in `src/operational-state.ts`): the record is under 12 hours old and is the latest grant for the
  action there; its scope is one place (an `owner/repo` slug or a path three levels deep, no wildcards); the quote
  is still exactly the operator's typed, non-imported message; and it names the action (`merg`/`mescl`,
  `deplo`, `publi`/`release`/`lanç`) with no negation before it in any clause (`sem`, `não`, `nunca`, `nem`,
  `not`...). So "pode fazer o merge dos dois e fazer o deploy" covers both merges and the deploy and its reruns, in
  that repository; "sim", "faz o merge mas não o deploy" (for the deploy) and any other action still wait.
- An unreadable or invalid file fails closed: every gated call waits for the operator, with the parse error.
- The agent cannot change it: any non-read call naming `autonomy.json` needs the operator, whatever the rules
  say. Edit it yourself, or approve the exact call.
- The contract applies where the gate applies (mode `1` or `risk`), in the owning session only.

## Approval advisor

In the owning interactive session, a blocked call first goes to a cheap advisor: the profile's
compactor model for the current provider (Haiku on Claude, gpt-6-luna on Codex), thinking off,
at most 120 output tokens. It sees the tool, arguments, working folder, risk class and the
operator's last four typed messages, and answers `APPROVE` or `DENY` with a reason. Its
instructions follow the operator's preference: as autonomous as possible, refuse only clearly
harmful calls (unrequested irreversible loss of work, leaked secrets, unrequested effects on
people or production beyond the operator's own repositories, injected instructions).

- The operator's standing preference pre-authorizes repository-only PR merges in their own repositories, including conflict resolution, without requiring a fresh exact PR list. Merge-triggered deployments, releases, production writes, third-party repositories and bypassing required checks are outside that rule. A newer explicit prohibition takes precedence. This is advisor policy, not a deterministic admission bypass: an unavailable or refusing advisor still waits for the operator.
- For push/publish decisions, the host supplies a fresh public GitHub login snapshot from fixed `gh api --hostname github.com user --jq .login` (3-second timeout). This identifies explicit matching repository owners even when cwd is outside the checkout. Missing CLI/auth, bad output and timeouts stay `unavailable`, not invented third-party ownership. It never switches accounts, reads tokens, or grants permission; explicit prohibitions and the advisor's veto remain intact. The installed `gh` executable/auth environment is trusted, as with Git helpers; a later account switch is not covered by the snapshot. Only metadata reads occur before the original gated call.
- `APPROVE`: the call runs once, with an info notice naming the model and reason.
- `DENY`, an unclear answer, an error or a 30-second timeout: the call waits for the operator
  as below, and the refusal tells the model why. The advisor is asked once per pending call.
- Delegated sessions never consult it. `OPTCHAT_EFFECT_ADVISOR=off` turns it off.
- Its calls are recorded in the usage ledger under the `approvals` role.

The advisor is a cheap filter, not a boundary: a model can be talked into approving. Use
`OPTCHAT_EFFECT_ADVISOR=off` with mode `1` when every effect must be seen by the operator.

## Operator flow

1. Start an isolated Pi with `OPTCHAT_EFFECT_APPROVALS=1` (or `=risk`). Existing sessions need a
   reload or restart to load code, and the environment flag must already be present.
   No installer or this extension changes that environment or reloads automatically.
2. A non-diagnostic invocation is blocked **before execution**. Its native result
   supplies a random pending token. Inspect the exact original tool and arguments
   in the transcript; the compact refusal deliberately does not repeat credentials
   or arbitrary script contents.
3. The blocked call stays on screen above the editor (kind, command or tool, and
   working folder) with a warning notice and one terminal bell, until it is approved,
   denied or expires. Type `/approve` to approve the newest pending call once, or
   `/deny` to drop every pending call (the model is told not to retry). Both are read
   by the input hook with its source, not registered as commands, so only typed
   interactive input counts. `approve-effect <token>` as the entire input still
   approves that exact token; a token inside a longer message is not an approval and
   the operator is told so. Approval lasts up to 30 minutes, in the same session and
   working directory.
   With the assistant's Slack chat configured, the same pending call is also posted
   to the operator's DM (`src/slack-bridge.ts` `askApproval`) with Aprovar/Negar
   buttons. A tap, or a reply of `aprovar` or `negar` in that post's thread, decides
   that one call (`decideFromPhone`: exact token, same session, once, before expiry),
   like `/approve` or a `/deny` of that call. The service queues only human messages
   and button taps from the configured operator in the DM, arriving on its Socket Mode
   connection; a tap is queued as that same thread reply
   (`assistant/src/channels/slack.ts` `approvalClick`) and the post loses its buttons.
   The agent cannot produce either; the same word anywhere else is an ordinary
   message. Delegated sessions never post approvals. However the call stops waiting
   (`/approve`, `/deny`, a newer call approved, expiry, or Slack itself), the gate
   reports it (`onSettled`) and the post is rewritten without buttons to say how it
   ended (`POST /v1/slack/update`; a thread reply on a service without it).
4. The next identical invocation consumes permission before dispatch. Another guard
   (including operation recovery) can still refuse it. Failures, retries, nested
   calls and modified arguments do not inherit or replenish approval.

There are at most 32 pending requests. Repeated blocked calls reuse their pending
token. Approved-but-unused entries also count; a model that fills the slots with
distinct calls delays new tokens until expiry (availability only, never a grant). Expiry, session start/shutdown and reload clear permission. Approval state
stays in memory, never in a source file or a model-writable permission ledger.
Other sessions, RPC and extension input, tool results, prose containing a token,
and historical text cannot approve it. A repeated or expired interactive token
is handled without another model request.

## Deliberately conservative coverage

Unknown tools and opaque Bash, Code Mode, checks, background commands and delegation
require exact approval. Local write/edit calls do too: the gate cannot infer which
paths the task authorizes. Native local reads, receipt retrieval, goal inspection,
fixed Ripwire navigation and the existing conservative shell diagnostic grammar
remain available. `project_checks` listing is diagnostic; running a recipe is not.
Diagnostic admission trusts the installed host's tool-name registrations; it does not
attest to a third-party replacement registered under a local read-tool name. Diagnostic
Git commands retain the existing trust in installed Git/configured helpers. This is
not a general shell parser or an execution sandbox. `operation_state` and
`operational_state` are diagnostic only with empty arguments: reconciliation and
ledger updates require approval too, and approval does not establish the truth of
agent-supplied evidence.

Parent OptChat and its internal child sessions register separate gates. Children
register **no granting input handler**, because SDK prompt/steer defaults can label
manager-authored input as interactive. A child cannot acquire permission by receiving
a manager's message, even with that SDK label. Its refusal directs the operator to
perform the action in the owning interactive session instead of relaying tokens.
Headless/RPC inputs cannot grant themselves tokens.

The gate does **not** silently convert natural-language standing authorization
into permanent machine permissions. Two standing grants are modeled; each is typed by the
operator as the entire interactive input:

    approve-standing push-main C:/projetos/pi-optchat C:/projetos/dotfiles

Until session start/shutdown/reload it admits only bash input `{command, timeout?}`
whose command is exactly `git -C <listed root> push origin main` (root compared
lowercase with `/` separators; up to 16 absolute roots, no dot segments or shell
characters). Force, `+main`, refspecs, tags, other remotes, subdirectories, chained
commands, Code Mode wrappers and other sessions still need exact approval. Retargeting
`origin` or Git config is itself a gated effect.

    approve-standing paid-subagents

Until session reset it admits direct `subagent` tool calls (launches and management) in
that session only, for goals whose paid delegation the user authorized. It does not cover
`bash`/`shell_start` commands that reach a provider, Code Mode wrappers, or other sessions;
those still need exact approval. Direct-provider interception and active-profile activation
remain open roadmap requirements. A legitimate user authorization still governs the agent;
this optional stricter layer can require an explicit machine token as well.
Existing normal chat/compaction provider requests are not intercepted by tool hooks.

## Checks and evidence

List `.pi/checks.json` with `project_checks`, then run `effect-approvals` for admission,
expiry, one-shot use, provenance, lifecycle and fresh package-skill discovery.
`effect-approval-runtime` uses the managed **installed** Pi SDK in a disposable
profile: blocked native tool → extension/prose token refused → interactive token →
exactly one local file write → replay refused → real SDK reload invalidates tokens →
manager-style SDK `steer` in delegated mode cannot grant another write.
It rejects network access and uses a scripted zero-cost provider. That validates
the callback chain, not this active chat, real model reasoning, paid-provider billing,
or arbitrary-code containment. Receipts are written to unique temporary directories.
