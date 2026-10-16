# Compactor size recovery

## Incident and cause

For node `15080+8`, local metadata-only diagnostics recorded a source of 893 UTF-8 bytes and five complete replies of 781, 739, 605, 546, and 516 bytes. The implementation discarded all five because acceptance was strictly 512 bytes. A later background attempt succeeded at 463 bytes. This was a size-rejection problem, not an empty stream.

Victor Taelin's UniiChat recipe says to retain the shortest reply after up to five attempts and allow a few extra bytes: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449 (consulted for this change). The initial fix bounded that exception to 32 extra bytes. A recurrence at node `15360+1024` (903-byte source, shortest reply 560 bytes, 512-byte target) showed that this merely moved the failure cliff to 544 bytes. The fallback now uses the actual safety invariant: a complete reply must shrink its source, and views budget actual bytes.

## Behavior

- Keep the normal 512-byte acceptance threshold (or the profile's configured tolerance).
- Ask for 448 UTF-8 bytes initially, or less for a shorter source, leaving headroom without changing the stable system prompt or tools.
- Correction messages report the measured size, real effective limit (`min(tolerance, source bytes - 1)`), source size, and a 7/8 safety target.
- After five attempts only, retain the shortest complete shrinking candidate, even above the target. Never truncate a reply to make it fit. There is no guaranteed 512-byte maximum; a poorly shrinking fallback can consume more context, which the existing actual-byte view accounting handles.
- Reject incomplete/truncated/tool-call outputs and non-shrinking candidates. Errors, provider refusals and cancellation retain their existing handling.
- Original messages remain append-only and zoomable. Tree/view accounting uses actual rendered bytes, including any accepted near miss. Saved views are reused on restart.

## Cache evidence and limits

System/tool definitions, four-line view blocks, cache marks, priming, cache TTL, model routing and sawtooth merge timing are unchanged. Only the task/correction suffix changes. A regression confirms identical initial request prefixes across all five attempts. Persistence coverage confirms the view is identical after restart, with no summary rebuilt.

The five failing requests had 117,248 cache-read tokens and 4,827 uncached input tokens in total (~96.0% cache reads among those input categories). That is observed historical provider-reported usage, not a post-change performance benchmark. Actual post-reload model compliance, summary quality and live cache-hit rate remain unverified; no paid model request was made to validate this change. No finite prompt can guarantee every model reply meets the byte limit or that recursive summaries preserve every fact; originals and zoom remain the recovery path.

## Recurrence regression

The updated synthetic regression uses a 903-byte source and replies of 720, 640, 560, 600 and 580 bytes. Before the fix it failed; after the fix it saves the shortest complete 560-byte reply, preserves the exact original through zoom, and reopens the identical persisted view without another model call. Boundary coverage accepts 902 bytes for a 903-byte source but rejects 903 bytes. UTF-8 measurement, cancellation, refusals, tool-call rejection and token-truncation handling remain unchanged. Live model behavior after reload is not verified; no paid inference is used for this regression.

Current local verification: focused compactor tests 16/16; full suite 400 passed, 1 skipped (401 total); TypeScript check passed; Pi 1.2 lifecycle compatibility 2/2; diff whitespace check passed. Ripwire edit-check and quality-delta exited 0. Static test-gate remains exit 4 for 14 transitively impacted symbols without graph-linked tests (mostly existing UI constructors/settings handlers); the executable suite passes. The configured Pi package path is `C:/projetos/pi-optchat`, which loads TypeScript directly. The user reports having run `/reload`. After that report, TypeScript and the 16 focused regression tests passed again. Live provider compaction remains unverified; no automatic reload or paid inference was performed.

## Previous verification (before recurrence fix)

- Red: three new regression tests failed against the old strict behavior, including the exact incident size sequence and inaccurate feedback.
- Green: TypeScript check passed; full suite 390 passed, 1 skipped (391 total); Pi 1.2 lifecycle compatibility 2/2.
- Focused 15/15: near-miss bounds, shortest candidate, source shrink requirement, UTF-8 bytes, truncated/tool-call rejection, shared prefix, source-bound feedback, persistence/restart and exact zoom.
- Ripwire edit checks exited 0; optional `task`/`tooLong` parameters have zero incompatible callers.
- Ripwire quality-delta exited 2: four gating short-horizon churn rows (`attempts`, `createCompressor`, `streamSimple`, `task`); complexity/verbosity increases were minor. No baseline file was present or recreated.
- Ripwire test-gate exited 4: fourteen transitive symbols lacked graph-linked coverage, mainly existing UI constructors/settings handlers. The full executable suite was run; this does not make the static gate green.

## Main consolidation / local activation

All user branches were checked for containment before consolidation. `origin/main`, `origin/recipe-faithful`, and `origin/windows-support` are ancestors of `lennix/shell-panel`; main can fast-forward to include their complete history plus the recovery fixes. No upstream experimental feature branches are silently included.

Pi loads TypeScript source directly; there is no emitted JavaScript build script. Prepare dependencies, typecheck, test, validate package contents and load the extension through Pi compatibility tests from the final main checkout. Configure the local package path to `C:/projetos/pi-optchat`, mirror that portable path in dotfiles, and let the user run `/reload` after verification. Keep the existing worktree and unrelated untracked files intact.


Final main-checkout verification: user branches consolidated by fast-forward; dependencies installed with `npm ci` (SDK 1.2.0, zero audited vulnerabilities); typecheck passed; full suite 390 passed/1 skipped; Pi lifecycle compatibility 2/2. Package dry-run contains required runtime modules and this document (52 files). Live settings and dotfiles package template now select the canonical main checkout. No automatic reload was performed. Existing worktree and unrelated untracked environment-verification plan were preserved.
