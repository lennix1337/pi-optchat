# OpenAI Codex CLI UX Ideas for pi-optchat

Source snapshot: `openai/codex` commit `8603da0718aafc6c7850f8820452f7e20350cc8b` (shallow clone inspected outside this repository).

Ideas below focus on how the agent communicates with the operator across **Slack mobile** (mrkdwn + Block Kit) and the **terminal TUI**, ranked by practical value to a reader on a phone screen.

## Slack mrkdwn & Block Kit Constraints

| Capability | Codex TUI | Slack Mobile (mrkdwn / Block Kit) | Workaround in pi-optchat |
| --- | --- | --- | --- |
| Arbitrary text colour | TrueColor / ANSI-256 (`style.rs`) | **Not supported** | `*bold*` lead sentence, `` `code` ``, emoji dots (`🟢`/`🟡`/`🔴`), Block Kit `context` (muted gray) |
| Inline named links | OSC 8 hidden-URL labels (`web_links.rs`) | **Supported** (`<url\|label>`) | Native mrkdwn `<url\|label>` with `unfurl_links: false` |
| Markdown tables | Auto-grid or key/value fallback | **Not supported** (raw pipes) | Transpose tables to vertical key/value lines in `slackText` |
| Tinted diff / plan fills | RGB line backgrounds (`diff_render.rs`, `plans.rs`) | **Not supported** | Block Kit `header` + `divider` or `>` quote rail; `` `+42 -11` `` in inline code |
| Shimmer / live spinner | Frame-animated (`status_indicator_widget.rs`) | **Not supported** | Static status emoji + elapsed time on App Home (`views.publish`) |
| Interactive choices | Bottom-pane selection list | **Supported** (Block Kit `actions`, ≤5 buttons) | `primary` (green) on recommended default, `danger` (red) on deny/stop; retire via `chat.update` |
| Push notification preview | OSC 9 / OSC 777 body (`notifications/osc.rs`) | **Supported** (`chat.postMessage` `text` field) | Put outcome/subject in the first ~100 chars of `text` even when sending `blocks` |

## Ranked Summary (Highest Phone-on-Slack Value First)

| Rank | Idea | Area | Effort | Slack Fit |
| ---: | --- | --- | :---: | --- |
| 1 | Scannable answer contract (bold takeaway + inline named source links) & hardened `slackText` | Message formatting | **S** | Fits (no text colour; use `*bold*`, `<url\|label>`, `context` block) |
| 2 | Transpose Markdown tables into vertical key/value records | Message formatting | **S** | Fits natively (mrkdwn) |
| 3 | Inline one-tap choice buttons on DM/channel questions with recommended default | Approvals / User input | **M** | Fits natively (Block Kit `actions`) |
| 4 | Richer approval cards (`Reason:`, target files, session/prefix allow button) | Approvals | **M** | Fits natively (Block Kit `section` + `context` + `actions`) |
| 5 | Bold-headline live progress & coalesced `Explored` counts (replace raw thinking dumps) | Progress / Status | **S** | Fits (static emoji instead of TUI shimmer) |
| 6 | Compact diff-stat summaries (`Edited N files (+A -D)`) in wake logs & approvals | Diff presentation | **S** | Fits (no green/red text; use `` `+A -D` `` or emoji) |
| 7 | First-class plan cards (`<proposed_plan>` + Implement button + live `N/M` checklist) | Plan presentation | **M** | Fits (Block Kit `header`/`actions` + `~strike~`; no tinted bg) |
| 8 | Priority-coalesced, preview-first notifications (Slack push `text` + TUI OSC 9/777) | Notifications | **S** | Fits partially (push `text` on Slack; OSC 9/777 is TUI-only) |
| 9 | Away-return structured recap (`summary` + `next_action`) | Progress / Status | **M** | Fits natively (mrkdwn / App Home card) |

---

## Detailed Ideas

### 1. Scannable Answer Contract (Bold Key Sentence + Inline Named Links) & Hardened `slackText`

- **Area:** Message formatting
- **Effort:** **S**
- **Slack mrkdwn / Block Kit fit:** **Fits with colour caveat.** Slack cannot apply custom foreground colours to text spans, so `*bold*` carries the key sentence, `<url|label>` carries inline named citations at the end of the sentence, and a Block Kit `context` block can render muted secondary metadata. Foreground colour on `strong`/`link`/`code` (`markdown_render.rs:174-205`) applies to the TUI only.
- **Codex reference:**
  - `codex-rs/core/gpt_5_2_prompt.md:172-240` (`### Final answer structure and style guidelines` — lead with outcome, short `**Title Case**` headers only when helpful, flat `- ` bullets ordered by importance, never mix bold and backticks, and explicit verbosity tiers at lines `225-230`).
  - `codex-rs/core/gpt-5.2-codex_prompt.md:56-80` (`## Presenting your work and final message` — skip "Summary:" filler, use numbered lists when proposing options so the user can reply with a single digit at line `59`, stand-alone clickable file references at lines `73-80`).
  - `codex-rs/tui/src/markdown_render/web_links.rs:55-64` (`WebLinkDisplay::hide_destination` / `hide_web_link_destination` — renders only the named link label when the terminal supports OSC 8, hiding raw URLs).
  - `codex-rs/tui/src/markdown_render/inline_directives.rs:130-248` (`InlineDirectives::events` — rewrites inline file citations into clickable links) and `codex-rs/tui/src/markdown_render.rs:174-205` (`MarkdownStyles::for_theme`).
- **What pi-optchat does today:**
  - `src/slack-policy.ts:15` (`budgetNote`) appends only `(Responda em até 100 palavras, numa mensagem só.)` — it gives no guidance on bold lead sentences, inline named links at sentence end, flat bullets, or numbered choices.
  - `src/prompts.ts:85-101` (`MASTER`) focuses on memory/delegation rules, not answer typography.
  - `assistant/src/channels/slack-relay.ts:289-294` (`slackText`) runs three naive regexes (`#` headings, `**bold**`, `[label](https://...)`) across the entire string: it can mangle `**` inside fenced/inline code, leaves `~~strikethrough~~` and `- [x]`/`- [ ]` unconverted, and drops non-HTTP file links (`[file](file:///...)`) as raw Markdown.
- **Concrete change:**
  1. Extend `budgetNote` in `src/slack-policy.ts:15` (and `slack_send`'s description in `src/slack-bridge.ts:870`) with a concise Slack style contract: open with the key outcome sentence in `**bold**`, cite URLs/PRs/issues as inline named links (`[PR #42](url)`) at the end of the sentence rather than bare URLs, keep lists flat (≤5 bullets), and number options when asking for a choice.
  2. Upgrade `slackText` in `assistant/src/channels/slack-relay.ts:289-294` to tokenize code fences/inline backticks before rewriting, convert `~~text~~` → `~text~` and `- [x]`/`- [ ]` → `☑`/`☐`, and format `[label](file:///.../path#L10)` cleanly as `` `path:10` `` (or a GitHub blob `<url|path:10>` when the repo remote is known).

---

### 2. Transpose Markdown Tables into Vertical Key/Value Records

- **Area:** Message formatting
- **Effort:** **S**
- **Slack mrkdwn / Block Kit fit:** **Fits natively (mrkdwn).** Slack mrkdwn has no table syntax at all; transposing tables to vertical records makes every comparison, quota summary, or status matrix immediately readable on a phone without Block Kit field-count limits.
- **Codex reference:**
  - `codex-rs/tui/src/markdown_render/table_key_value.rs:31-71` (`should_render_records`) and `98-220` (`render_records`, `render_aligned_field`, `render_stacked_field` — detects when grid columns cramp or fragment tokens and transposes each row into `Header  value` / stacked key-value cards separated by horizontal rules).
  - `codex-rs/tui/src/markdown_render.rs:1508-1589` (`render_table_lines` — classifies columns as `Narrative`, `TokenHeavy`, or `Compact` and falls back to `table_key_value::render_records`).
- **What pi-optchat does today:**
  - `assistant/src/channels/slack-relay.ts:289-294` (`slackText`) has no table handling (verified by grep across `src/slack-*.ts` and `assistant/src/channels/slack*.ts`); any Markdown table emitted by the model lands in Slack as broken, wrapped `| col | col |` lines.
- **Concrete change:**
  - Add a GFM pipe-table transformer inside `slackText` (`assistant/src/channels/slack-relay.ts:289`) outside fenced code blocks:
    - For 2-column tables (`Key | Value`), emit `• *Key:* Value`.
    - For 3+ columns, promote column 1 as the record heading (`*Row title*`) and emit indented `Key: value` lines separated by a blank line (or `───`), preserving inline `<url|label>` links and `` `code` `` inside cells.

---

### 3. Inline One-Tap Choice Buttons on DM/Channel Questions (with Recommended Default)

- **Area:** Approvals / User input
- **Effort:** **M**
- **Slack mrkdwn / Block Kit fit:** **Fits natively (Block Kit `section` + `actions`).** Up to 5 buttons fit in one `actions` block; the recommended option gets `style: 'primary'`, and clicking retires the buttons via `chat.update` just like existing approvals.
- **Codex reference:**
  - `codex-rs/collaboration-mode-templates/templates/plan.md:60-90` (`## Asking questions` — structured `request_user_input` with 2–4 mutually exclusive options and an explicit recommended default).
  - `codex-rs/tui/src/bottom_pane/questions.rs:66-92` (`BottomPane::question_summary` — shows pending unanswered count, countdown, and direct answer affordance).
  - `codex-rs/tui/src/history_cell/request_user_input.rs:19-131` (`RequestUserInputResultCell::display_hyperlink_lines` — records `Questions N/M answered`, selected option, optional freeform note, and redacts secret answers as `••••••` at lines `79-87`).
  - `codex-rs/tui/src/history_cell/async_questions.rs:44-81` (`render` — renders each `? Question` title in accent style above its options).
- **What pi-optchat does today:**
  - `src/commitments.ts:338-342` (`waitingItems`) and `src/slack-bridge.ts:348-350,482` (`waitingBlock`, `home()`) only render `choices` as clickable buttons on the **App Home** tab (`assistant/src/channels/slack-relay.ts:253-256`, `HOME_CHOICE`).
  - DM replies (`src/slack-bridge.ts:608-617`, `answer()`) and `slack_send` (`src/slack-bridge.ts:868-882`) support only plain text or `approval` (Aprovar/Negar) buttons — the operator cannot tap an answer directly inside the DM notification thread.
- **Concrete change:**
  - Add an optional `choices?: string[]` (2–4 labels, recommended first) parameter to `slack_send` (`src/slack-bridge.ts:871-876`) and `SlackPoster.send` (`assistant/src/channels/slack-relay.ts:325-343`).
  - Render a Block Kit `section` + `actions` row under the message (first button `style: 'primary'`). On click in `assistant/src/channels/slack.ts:55-67`, validate the operator, enqueue the chosen label into the same DM/thread (reusing `homeChoice`'s safety guard at `assistant/src/channels/slack.ts:115-121`), and retire the buttons with `→ Escolhido: *<option>*`.

---

### 4. Richer Approval Cards (`Reason:`, Target Files, and Session/Prefix Allow Button)

- **Area:** Approvals
- **Effort:** **M**
- **Slack mrkdwn / Block Kit fit:** **Fits natively (Block Kit `section` + `context` + `actions`).** `primary` (green), default, and `danger` (red) button styles cleanly separate "Approve once", "Approve for session", and "Deny" without needing text colours.
- **Codex reference:**
  - `codex-rs/tui/src/bottom_pane/approval_overlay.rs:728-801` (`build_header` — displays `Reason:` in italic, `Permission rule:` in accent, `Thread:`/`Environment:`, and `$ command`).
  - `codex-rs/tui/src/bottom_pane/approval_overlay.rs:873-950` (`exec_options` — offers *"Yes, proceed"*, *"Yes, and don't ask again for commands that start with `<prefix>`"*, *"Yes, and allow for this session"*, and *"No, continue without running it"*).
  - `codex-rs/tui/src/bottom_pane/apply_patch_header.rs:11-72` (`build_header` — shows human `Description:` plus a sorted, deduplicated list of affected file `Destination:` paths).
- **What pi-optchat does today:**
  - `src/slack-bridge.ts:682-695` (`askApproval`) and `assistant/src/channels/slack-relay.ts:280-286` (`approvalBlocks`) post `⏸ *Aprovação pendente* · label: summary` + a raw verbatim `detail` code block (`src/authorization.ts:253-258`, `describeInvocation`) with only two buttons (`Aprovar` once / `Negar`).
  - Session-wide standing grants (`src/authorization.ts:284-289`, `standingKeys`) only exist for `push-main <root>` and `paid-subagents` via typed terminal commands (`src/authorization-hooks.ts:71-72`), never as a phone button, and neither Slack nor the TUI widget (`src/authorization-hooks.ts:28-33`) displays a human `Reason:` or affected-file summary.
- **Concrete change:**
  1. Carry optional `reason` and `targets` (affected repo/files) on `PendingApproval` (`src/authorization.ts:13`) and `ApprovalRequest` (`src/slack-bridge.ts:76-80`).
  2. Format Slack approval cards with a concise `section` (`*Motivo:* ...`, target files/command) + muted `context` line (`Vale 30 min · Escopo: 1 chamada`) + a 3rd button (`Aprovar nesta sessão`) strictly for eligible non-destructive standing classes (`push-main`, `paid-subagents`), while keeping `production-write`, `deploy`, `database destructive`, and `autonomy.json` locked to 1-shot approval.

---

### 5. Bold-Headline Live Progress & Coalesced `Explored` Steps (Replace Raw Thinking Dumps)

- **Area:** Progress / Status display
- **Effort:** **S**
- **Slack mrkdwn / Block Kit fit:** **Fits cleanly (mrkdwn / App Home `section` + `context`).** Slack cannot animate Codex's shimmer text (`status_indicator_widget.rs:247-251`), so static status emoji + elapsed time + coalesced step counts give the same low-noise clarity on mobile.
- **Codex reference:**
  - `codex-rs/tui/src/chatwidget.rs:2160-2186` (`extract_first_bold`) and `codex-rs/tui/src/app/agents_overview_details.rs:80-108` (`ReasoningSummaryTextDelta` — pulls only the first `**bold**` heading out of streamed reasoning summaries to serve as a 1-line status title instead of dumping prose).
  - `codex-rs/tui/src/exec_cell/render.rs:362-496` (`exploring_display_lines` — collapses consecutive `Read`/`List`/`Search` tool calls into one `Exploring` / `Explored` summary block rather than noisy per-call rows).
  - `codex-rs/tui/src/status_indicator_widget.rs:79-92,225-293` (`fmt_elapsed_compact`, `StatusIndicator::lines` — single-line status with compact clock `1m 05s` and ≤3 detail lines).
  - `codex-rs/protocol/src/prompts/base_instructions/default.md:31-50,173-179` (`### Preamble messages` & `## Sharing progress updates` — concise 8–12 word plain-language milestones before slow work).
- **What pi-optchat does today:**
  - `src/slack-bridge.ts:124-133` (`recentThoughts`) clips the last 3 raw `thinking` blocks to 220 characters each and renders them under `*Pensando*` in `showWork()` (`src/slack-bridge.ts:320-330`), which often reads like mid-sentence internal monologue on a phone.
  - `src/slack-bridge.ts:147-156,300-308` (`stepLabel`, `toolStarted`) overwrites a single `this.work.step` string (`lendo foo.ts`) plus a raw step count (`14 passos`), never coalescing exploration vs editing vs testing (even though `src/waiting-board.ts:104-114`, `phaseOf`, already classifies tools into `lendo código`, `editando`, `testes`, `git` for the TUI board).
- **Concrete change:**
  1. In `src/slack-bridge.ts:124-133`, extract only a short headline (first `**...**` span if present, else first sentence ≤90 chars) for App Home's live status instead of three 220-char raw thinking quotes.
  2. Accumulate coalesced phase counters on `this.work` (`reads`, `searches`, `edits`, `tests` using `phaseOf` from `src/waiting-board.ts:104`) and render a single scannable line in `showWork()` (`src/slack-bridge.ts:327-329`), e.g.: `🔍 Explorou 7 arquivos · ✏️ editou 2 · 🧪 rodando testes há 38s`.

---

### 6. Compact Diff-Stat Summaries (`Edited N files (+A -D)`) in Wake Logs & Edit Approvals

- **Area:** Diff presentation
- **Effort:** **S**
- **Slack mrkdwn / Block Kit fit:** **Fits with colour caveat.** Slack cannot colour `+42` green and `-11` red inline (unlike `diff_render.rs:429-431`) or paint tinted diff backgrounds (`diff_render.rs:64-79`, TUI-only). Using inline code `` `+42 -11` `` (or `🟢 +42 · 🔴 -11`) and bounded fenced hunks gives crisp blast-radius visibility on mobile.
- **Codex reference:**
  - `codex-rs/tui/src/diff_render.rs:358-492` (`create_diff_summary`, `create_diff_preview_with_links`, `render_line_count_summary` at lines `426-434`, `render_changes_block` at lines `436-492` — prints `• Edited 3 files (+42 -11)` / `• Added foo.ts (+18 -0)`, per-file rows `  └ path (+30 -5)`, rename arrows `old → new`, and bounded preview lines).
- **What pi-optchat does today:**
  - `src/wake-log.ts:80-85,100` (`wakeEffects`) emits only basenames (`pi-optchat: editou slack-bridge.ts, slack-policy.ts`) with no line counts, no add/delete/rename labels, and no diff preview.
  - `src/slack-bridge.ts:682-687` (`askApproval`) dumps raw `describeInvocation` JSON/command text without `+A -D` summaries.
- **Concrete change:**
  - Compute added/removed line counts from `edit`/`write` arguments (or `git diff --numstat` when available) in `src/wake-log.ts:80-100` and format effects as:
    - `pi-optchat: *editou 2 arquivos* (\`+42 -11\`) — \`slack-bridge.ts\` (\`+30 -9\`), \`slack-policy.ts\` (\`+12 -2\`)`
  - For file-edit approvals (`src/slack-bridge.ts:686`), show the file-count/line-delta header and cap any inline diff preview to ≤8 changed lines.

---

### 7. First-Class Plan Cards (`<proposed_plan>` + Implement Button + Live `N/M` Checklist)

- **Area:** Plan presentation
- **Effort:** **M**
- **Slack mrkdwn / Block Kit fit:** **Fits with background caveat.** Slack lacks Codex's tinted plan surface (`plans.rs:157-176`, TUI-only), but Block Kit `header` + `divider` + `section` + `actions` (`Implementar` primary, `Revisar` default) and mrkdwn `~strikethrough~` for completed steps translate cleanly to mobile.
- **Codex reference:**
  - `codex-rs/collaboration-mode-templates/templates/plan.md:96-126` (`<proposed_plan>` block with 3–5 compact sections — Summary, Key Changes, Test Plan, Assumptions — and explicit ban on "should I proceed?" filler).
  - `codex-rs/tui/src/chatwidget/plan_implementation.rs:9-105` (`selection_view_params` — immediately renders *"Yes, implement this plan"*, *"Yes, clear context and implement (current context: 89% used)"*, *"No, stay in Plan mode"*).
  - `codex-rs/tui/src/history_cell/plans.rs:264-374` (`PlanUpdateCell::compact_hyperlink_lines` & `display_hyperlink_lines` — `Updated Plan · 2/5 complete`, sorts `in_progress` first in compact view, marks completed items `✔` + crossed-out).
  - `codex-rs/tui/src/markdown_render/task_lists.rs:8-27` (`task_list_marker` — converts `- [x]` / `- [ ]` to `☑` / `☐`).
- **What pi-optchat does today:**
  - `src/slack-reports.ts:179-180` (`composeSummary`) only builds a static 3-item `*Plano do dia*` in the 07:00 briefing; there is no structured `<proposed_plan>` card, no live `N/M` checklist widget during multi-step execution, and no one-tap "Implementar" / "Limpar contexto e implementar" button on Slack.
- **Concrete change:**
  - Detect `<proposed_plan>...</proposed_plan>` in `assistant/src/channels/slack-relay.ts:325-343`: strip the XML tags, render a Block Kit `header` (`Plano proposto`) + `section` + `actions` (`Implementar` primary, `Ajustar plano` default), and optionally show a live `N/M` checklist (`✔ ~feito~`, `▶️ *agora*`, `⬜ próximo`) on App Home during long multi-step runs.

---

### 8. Priority-Coalesced, Preview-First Notifications (Slack Push `text` + TUI OSC 9/777)

- **Area:** Notifications
- **Effort:** **S**
- **Slack mrkdwn / Block Kit fit:** **Fits for Slack push previews; OSC 9/777 is TUI-only.** On Slack mobile, the lock-screen banner renders the top-level `text` field of `chat.postMessage` (even when `blocks` are attached), so crafting a concise preview-first `text` directly improves phone notifications.
- **Codex reference:**
  - `codex-rs/tui/src/chatwidget/notifications.rs:6-131` (`ChatWidget::notify`, `Notification::display`, `priority()` at lines `80-89` where approvals/questions override turn-complete, `agent_turn_preview` at lines `98-112` producing a clean 200-grapheme preview, and `EditApprovalRequested` at lines `46-56` summarizing `Codex wants to edit 3 files`).
  - `codex-rs/tui/src/notifications/mod.rs:20-67` & `codex-rs/tui/src/notifications/osc.rs:60-85` (`DesktopNotificationBackend`, `PostNotification::write_ansi` — auto-detects OSC 9 vs OSC 777 with tmux DCS passthrough, falls back to BEL, sanitizes control characters).
  - `codex-rs/tui/src/tui/notification_preview.rs:6-14` (`notify_test` — focus-aware filtering in normal operation, bypassable for preview tests).
- **What pi-optchat does today:**
  - In the TUI, `src/authorization-hooks.ts:23,298` (`terminalBell`) writes only a bare `\x07` (BEL) on approvals — no text preview, no OSC 9/777, no turn-complete alert, and no priority coalescing.
  - In the assistant service, `assistant/src/notifications/center.ts:34-47` (`lockScreenText`) uses intentionally opaque strings for local/web channels (with good burst capping at lines `155-178` and quiet hours at lines `71-74`).
  - On Slack, `assistant/src/channels/slack-relay.ts:335` passes the raw full `chunk` as `text`, and `src/wake-log.ts:111` starts posts with `*Wake* 03:12→03:15 (3 min, 14 passos)` — wasting the phone's 1-line push preview on timestamps/step counts instead of the delivered outcome.
- **Concrete change:**
  1. **Slack push preview:** pass a dedicated `preview` string (≤120 chars, leading with the outcome/subject — e.g. `Aprovar push em pi-optchat` or `Wake: abriu PR #291`) as the top-level `text` when `blocks` are present in `SlackPoster.send` (`assistant/src/channels/slack-relay.ts:335`), and put the concise outcome ahead of timestamps in `wakeLogPost` (`src/wake-log.ts:111`).
  2. **TUI alerts:** extend `terminalBell` (`src/authorization-hooks.ts:23`) with terminal-aware OSC 9/777 (falling back to `\x07` on Windows Terminal) and priority coalescing (`approval > question > turn-complete`).

---

### 9. Away-Return Structured Recap (`summary` + `next_action`)

- **Area:** Progress / Status display
- **Effort:** **M**
- **Slack mrkdwn / Block Kit fit:** **Fits natively (mrkdwn / App Home card).** Two short fields (`summary` + `next_action`) fit cleanly in a single mobile viewport without scrolling.
- **Codex reference:**
  - `codex-rs/tui/src/app/recap.rs:34-104` (`RECAP_DELAY` = 30 min, `MIN_COMPLETED_TURNS` = 3, `GeneratedRecap { summary, next_action }` bounded to 700 / 200 chars via strict JSON schema at lines `67-84`) and `request_recap` (`184-250` — runs a temporary, non-polluting structured turn after inactivity or manual `/recap`).
- **What pi-optchat does today:**
  - `src/catchup.ts:122-149` (`renderCatchup`) and `src/catchup-integration.ts:92-118` provide a thorough deterministic `/catchup` receipt in the TUI (wakes, observed PRs/checks, paged log), but it is verbose, TUI-only, and offers no 2-line synthesized `summary` + `next_action` for Slack.
  - App Home's `Última resposta` (`src/slack-bridge.ts:107-110,639`, `replyLead`) only shows the first 280 chars of the single most recent message, missing earlier wakes or background completions that happened while the operator was away.
- **Concrete change:**
  - Add a `resumo` remote Slack command (`src/slack-bridge.ts:390`) — and an optional App Home *Retomada* card triggered when ≥30 min elapsed with ≥3 wakes/turns since `onInbound` (`src/slack-bridge.ts:411`) — that feeds `buildCatchup` (`src/catchup.ts`) into a cheap bounded structured summary (`summary` ≤400 chars, `next_action` ≤140 chars), keeping deterministic evidence links intact.

---

## Suggested Implementation Order

1. **Quick wins (1 PR, all Effort S):** Ideas **#1** (answer contract + hardened `slackText`), **#2** (Markdown table → key/value records), **#5** (bold-headline progress + coalesced phase counters), and **#6** (`+A -D` diff stats in `wake-log.ts`). Immediate, visible improvement on every Slack phone message with zero new Slack permissions.
2. **Interactive phone ergonomics (Effort M):** Ideas **#3** (inline choice buttons in DM) and **#4** (approval `Reason:` + session allow button), reusing `assistant/src/channels/slack.ts`'s existing `block_actions` + `chat.update` retirement path.
3. **Workflow & alert polish (Effort S–M):** Ideas **#8** (preview-first push `text` + TUI OSC 9/777), **#7** (`<proposed_plan>` cards), and **#9** (away-return recap).
