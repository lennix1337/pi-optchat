# OptChat investigation and implementation

Base: `90d6ab7fb`, OptChat 0.8.4. The user authorized the three audit fixes, the three context improvements, and publishing all OptChat work including Shells after integrated validation. See [validation tracker](context-improvements-validation.md).

## Implemented

- Compactor rejects nonshrinking/oversized summaries after five attempts; regression reproduced before fixing.
- Memory browser correctly distinguishes unchanged leaves and nested summaries; synthetic tests and actual Chromium expansion/original toggle verified.
- SDK pins and CI compatibility gate target Pi 1.2. Loader and isolated session lifecycle checks pass (2/2); headless tests distinguish compactor requests from main inference without weakening the later-extension assertion.
- Live user/custom instructions survive repeated refreshes exactly, including image-bearing tasks.
- Complete main and child tool-result text is recoverable with paged zoom; durable main-store restart and child transcript recovery tested. Child image attachments remain outside the text transcript contract.
- Assembled prompt/tool/memory/run budgets reserve model output plus 5% headroom, coarsen existing summaries, and abort explicitly when retained input cannot fit.
- Shells inventory, managed background execution and inspector controls are included; live terminal UI activation is not verified.

## Final local evidence

Full suite: 346 passed, 0 failed, 1 expected Windows-only skip (347 tests). Type-check, dependency audit (zero vulnerabilities), Pi compatibility 2/2, package dry run and diff whitespace checks pass. Synthetic tests do not establish provider semantic recall or exact token accounting. No paid inference.

## Static gate limitations

Ripwire compared the combined worktree against unpinned Git HEAD. Quality-delta exits 2 with 17 gating findings (Shells complexity/length, duplication and short-horizon churn); test-gate exits 4 with 17 statically unreached symbols and 41 suggested test files, with 567 ambiguous and 390 unresolved bindings. Gates have not passed. The full suite runs the suggested regression files, except the opt-in real-provider benchmark. Runtime/browser evidence does not clear static findings. See the validation tracker for independent review and publishing status.

## Investigation

[Context/performance findings](context-performance-investigation.md) record pre-fix synthetic evidence and recommended priorities. `context-probe.mjs` reproduces the original baseline scenarios, including intentionally bounding a result before logging and checking the old run-only threshold; it is not the implementation acceptance suite. Run with `node --experimental-transform-types plans/context-probe.mjs`. Regression tests exercise the corrected executed paths.

Retrieval-quality evaluations and privacy-safe diagnostics remain possible follow-ups. Search/storage changes require a measured bottleneck; no vector database, broad refactor, paid evaluation or speculative optimization was added.
