---
name: optchat-catchup
description: Report work since the operator's previous message, after an absence or heartbeat wakes; list deliveries, observed PRs/checks and pending operator actions without reconstructing counts from summaries.
---

# Catch up from receipts

1. Read `catchup_report` (summary). Its frozen human-delimited interval is the scope; commands and repeated reads leave that boundary unchanged. Start the reply with the exact interval and wake count, not the number of PRs.
2. Cover all reported work and extracted PR/check observations, then operator decisions, uncertain outcomes and active jobs. Assistant prose is self-reported; a check proves only that check. A completion or a read of its artifact is not a user-visible response. Present its conclusion promptly or explicitly say review is pending.
3. If a follow-up message displaced the absence interval, use `view: "history"`, then the returned `window` index. `view: "log", offset: ...` pages every original event; `zoom` opens its source. Counts exclude hidden nested Code Mode calls and other profiles.
4. PR states are last observed, not live. Verify the relevant remote before a consequential action; the receipt grants no approval. Preserve pending exact-invocation approval fences.

The read-only TUI renders Markdown sections and inline source commands; `/catchup json` uses native JSON syntax coloring. PR URLs use native terminal hyperlinks where supported (Ctrl+click in common terminals), with a visible URL to copy otherwise. Source/continuation commands remain copyable, never auto-execute. Activate changed extension source with an authorized reload; source tests do not prove the current session has loaded it.

If tracking had not started, say so. `/catchup range <from> <to>` supplies an explicitly historical range (end exclusive); do not manufacture a trusted human boundary for old imports. `/catchup live` shows the current interval. The read-only TUI is also under `/optchat catchup`; `/catchup history`, `window <index>`, `log <offset> [window]`, and `json` disclose details. `/reload` activates new source only when existing jobs can safely end; it is not done by this skill.
