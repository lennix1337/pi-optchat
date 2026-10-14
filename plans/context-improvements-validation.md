# Authorized context improvements — validation tracker

User authorized implementation of all three context recommendations and pushing all OptChat work after these and the Pi 1.2 integration finish. Preserve existing Shells changes. No paid inference.

## Acceptance criteria

| Requirement | Required evidence | Status |
| --- | --- | --- |
| Exact live instructions | Multiple steering/custom messages and their order survive refresh and repeated refresh; images preserved; complete final tool exchange; oversized instructions fail explicitly without mutating originals | Verified in focused refresh tests, including repeated refreshes and image-bearing tasks; oversized context refuses without discarding raw instructions. |
| Recoverable full tool originals | Unique head/middle/tail facts recoverable through paged zoom before and after durable-store restart; request previews remain bounded; provenance/pairing intact | Verified: focused output/transcript tests (46), memory tests (44), and fresh integrated full suite pass; complete paged text recovery and restart regressions included. |
| Assembled context budget | Small/large model windows, system prompt/tools/view/run/reserve, Unicode, model switching, oversized input; explicit conservative estimates; view reduction using existing summaries; no silent instruction loss | Verified in focused tests and real provider-capture regressions for main and child requests. Child `Context.messages` carries prompt sections and system tool deltas; SDK replay helpers confirm the rendered prompt/active tools, and the estimate asserts both contribute. |
| Pi 1.2 compatibility | Loader/registration plus isolated lifecycle execution; headless fixture distinguishes compaction from main inference and retains later-extension assertion | Verified: fresh Pi compatibility 2/2, full suite and type-check pass; headless 10/10 and isolated start/shutdown with zero inference. |
| Integrated regressions | Fresh type-check, full suite, compatibility gate, diff review, dependency audit; evaluate Ripwire failures separately | Type-check, full suite (346 passed, 1 expected skip), Pi compatibility (2/2), and diff whitespace check pass. Independent review completed with no blocking correctness/security findings; focused mid-turn tests 8/8 and full suite reconfirmed. Ripwire quality/test gates remain nonzero; findings are recorded below. |
| Publish | Verify active GitHub account, review status/diff and staged content, commit only task changes, push canonical destination and verify remote SHA; no force push | Staged 33 task files; credential-pattern scan and staged whitespace check pass. Independent review completed with no blockers; authorized publication destination is `origin/lennix/shell-panel` (no force push). |

## Existing evidence

Compactor rejects invalid oversized fallback after five attempts; original preserved. Browser rendering fixes passed synthetic regressions and real Chromium validation. Earlier independent review found no issues in either fix. Pi compatibility agent's latest full suite: 338 passed, 1 skipped, zero failures; type-check and diff-check passed. Headless fixture now separates compaction requests from ordinary model turns; later-extension assertion remains. Linux/CI execution not verified. Static Ripwire gates were unpassed (quality-delta exit 2, test-gate exit 4); do not claim these passed.

## Integration review

Independent review verified main-path original persistence and parallel result pairing. It found that child transcripts cap tool results before paging (`src/transcript.ts`); agent f0de0787 removed that cap and added complete paging, middle-content, and restart regressions. Independent review completed: no blocking correctness/security findings; complete text-result paging fixes and main persistence are verified. Main-path helper tests alone do not satisfy full child-output retrieval.

## Publishing base

After fetching origin, `origin/main` and branch HEAD both resolve to `90d6ab7` (0 ahead/0 behind). The earlier 48-ahead count used a stale remote-tracking ref. Preserve the main checkout; publish the verified worktree branch `lennix/shell-panel` without a force push.

## Boundaries

`zoom(agent)` exposes a text transcript: child tool-result text is complete and pageable, but image blocks are omitted by `textContent(..., false)`. This image omission is unchanged by the text-output recovery fix; image retrieval/storage remains out of scope. Synthetic/no-provider checks do not prove real-model semantic recall, provider token accounting, cache hits, or live Shells UI activation. Do not substitute approximate budgeting for an exact tokenizer claim. No paid generation, deployment, secrets, or personal histories in fixtures.

## Latest integrated checkpoint

Fresh type-check passes; full suite: 346 passed, 0 failed, 1 expected Windows-only skip (347 total); Pi compatibility: 2/2 passed; `git diff --check` exits 0 (with an unrelated CRLF normalization warning in `test/inspector.test.ts`). The child provider callback receives a normalized Pi transcript: `SystemMessage.content` is empty while `sections` and `toolsAdded` carry the active prompt/schema deltas. The real child regression now replays/renders those fields with Pi's `getCurrentSystemMessage`, `getCurrentSystemPrompt`, and `getCurrentTools`; it verifies both prompt sections and active schemas contribute to the Pi estimate and the captured request fits the output-reserved budget. Ripwire `--quality-delta` exits 2 with 17 pre-existing-worse major findings across the combined dirty tree; it also reports a `chars`/`estimatedContextTokens` overlap and the new `budgetContext` parameter count. `--test-gate` exits 4 with 17 untested symbols and 41 test files for which the runner is not derivable in this large dirty tree. Independent review completed without blockers; the remaining static findings are advisory maintainability/coverage limitations, not passing gates. Child image attachments in agent transcripts remain an out-of-scope limitation; complete text-output recovery is independently covered.
