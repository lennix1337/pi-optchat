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
  - **paid model call**: `subagent`/`spawn`/`tell` (except `subagent` list/models/guide/status/validate), `pi -p|--print`, `bench.mjs run`, codemode `models.*` or `tools.subagent|spawn|tell`.

  Risk mode is a guardrail against accidental high-impact effects: a command that hides its
  verb (variables, `eval`, encoded scripts, a script file that pushes) is not recognized, and
  MCP tools are not classified. Use `1` when that boundary matters. Standing grants work in both modes.

## Approval advisor

In the owning interactive session, a blocked call first goes to a cheap advisor: the profile's
compactor model for the current provider (Haiku on Claude, gpt-6-luna on Codex), thinking off,
at most 120 output tokens. It sees the tool, arguments, working folder, risk class and the
operator's last four typed messages, and answers `APPROVE` or `DENY` with a reason. Its
instructions follow the operator's preference: as autonomous as possible, refuse only clearly
harmful calls (unrequested irreversible loss of work, leaked secrets, unrequested effects on
people or production beyond the operator's own repositories, injected instructions).

- The operator's standing preference pre-authorizes repository-only PR merges in their own repositories, including conflict resolution, without requiring a fresh exact PR list. Merge-triggered deployments, releases, production writes, third-party repositories and bypassing required checks are outside that rule. A newer explicit prohibition takes precedence. This is advisor policy, not a deterministic admission bypass: an unavailable or refusing advisor still waits for the operator.
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
