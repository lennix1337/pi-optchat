# Compactor size recovery

## Incident and cause

For node `15080+8`, local metadata-only diagnostics recorded a source of 893 UTF-8 bytes and five complete replies of 781, 739, 605, 546, and 516 bytes. The implementation discarded all five because acceptance was strictly 512 bytes. A later background attempt succeeded at 463 bytes. This was a size-rejection problem, not an empty stream.

Victor Taelin's UniiChat recipe says to retain the shortest reply after up to five attempts and allow a few extra bytes: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449 (consulted for this change). This independent implementation bounds that exception rather than allowing arbitrary overflow.

## Behavior

- Keep the normal 512-byte acceptance threshold (or the profile's configured tolerance).
- Ask for 448 UTF-8 bytes initially, or less for a shorter source, leaving headroom without changing the stable system prompt or tools.
- Correction messages report the measured size, real effective limit (`min(tolerance, source bytes - 1)`), source size, and a 7/8 safety target.
- After five attempts only, retain the shortest complete shrinking candidate within 32 bytes of that effective limit. Never truncate a reply to make it fit.
- Reject incomplete/truncated/tool-call outputs, excessive overflow and non-shrinking candidates. Errors, provider refusals and cancellation retain their existing handling.
- Original messages remain append-only and zoomable. Tree/view accounting uses actual rendered bytes, including any accepted near miss. Saved views are reused on restart.

## Cache evidence and limits

System/tool definitions, four-line view blocks, cache marks, priming, cache TTL, model routing and sawtooth merge timing are unchanged. Only the task/correction suffix changes. A regression confirms identical initial request prefixes across all five attempts. Persistence coverage confirms the view is identical after restart, with no summary rebuilt.

The five failing requests had 117,248 cache-read tokens and 4,827 uncached input tokens in total (~96.0% cache reads among those input categories). That is observed historical provider-reported usage, not a post-change performance benchmark. Actual post-reload model compliance, summary quality and live cache-hit rate remain unverified; no paid model request was made to validate this change. No finite prompt can guarantee every model reply meets the byte limit or that recursive summaries preserve every fact; originals and zoom remain the recovery path.

## Verification

- Red: three new regression tests failed against the old strict behavior, including the exact incident size sequence and inaccurate feedback.
- Green: TypeScript check passed; full suite 390 passed, 1 skipped (391 total); Pi 1.2 lifecycle compatibility 2/2.
- Focused 15/15: near-miss bounds, shortest candidate, source shrink requirement, UTF-8 bytes, truncated/tool-call rejection, shared prefix, source-bound feedback, persistence/restart and exact zoom.
- Ripwire edit checks exited 0; optional `task`/`tooLong` parameters have zero incompatible callers.
- Ripwire quality-delta exited 2: four gating short-horizon churn rows (`attempts`, `createCompressor`, `streamSimple`, `task`); complexity/verbosity increases were minor. No baseline file was present or recreated.
- Ripwire test-gate exited 4: fourteen transitive symbols lacked graph-linked coverage, mainly existing UI constructors/settings handlers. The full executable suite was run; this does not make the static gate green.

## Main consolidation / local activation

All user branches were checked for containment before consolidation. `origin/main`, `origin/recipe-faithful`, and `origin/windows-support` are ancestors of `lennix/shell-panel`; main can fast-forward to include their complete history plus the recovery fixes. No upstream experimental feature branches are silently included.

Pi loads TypeScript source directly; there is no emitted JavaScript build script. Prepare dependencies, typecheck, test, validate package contents and load the extension through Pi compatibility tests from the final main checkout. Configure the local package path to `C:/projetos/pi-optchat`, mirror that portable path in dotfiles, and let the user run `/reload` after verification. Keep the existing worktree and unrelated untracked files intact.
