# Resolution on demand

OptChat keeps Victor Taelin's permanent append-only originals, binary summary tree and chronological sawtooth view. Working focus adds resolution to recently opened subjects without replacing the tree or creating another authored memory.

## Working focus

Successful main-agent memory zooms leave bounded references, not summary copies. The main session resolves them from memory at the next turn or completed-exchange refresh boundary. The snapshot then stays fixed until the next such boundary: a zoom does not churn the request prefix on every subsequent tool call.

Focus follows recent use, expires after unused turns, and belongs to one open profile session. Closing/reopening a profile or restarting Pi clears it; originals and summaries survive. It is a small retrieval cache, not permanent pins, a task ledger or an authorization record. Current instructions, state, complete tool exchanges and chronological history take priority: request fitting discards focus first. No extra summarizer, embeddings, global scan or model-facing remaining-token counter is added.

The historical frame explicitly distinguishes excerpts from new instructions. Old permissions can appear in a useful original; later applicable user corrections remain authoritative. The harness does not claim to understand which historical statement applies semantically.

## Precise zoom and agent experience

Keep using `zoom({id, n})`, `zoom({id, n: 1})` and original-message pagination. When a view branch is known, an optional literal `findText` locates source passages inside it. It is not global memory search or semantic retrieval. Follow returned source-located zoom calls, narrow oversized branches, and use the newest applicable original when summaries mention corrections. Existing original/image reads and agent transcript reads retain their contracts.

The package exposes the `optchat-memory` skill for topic resumption, exact passage lookup and conflicting historical decisions. Its short navigation steps are **AX (agent experience)** guidance; this feature does not invent or depend on a separate AXI standard.

## Summaries as signposts

The active compactor task preserves subject identifiers, decisions/reasons, corrections/revocations, scope and attempted-versus-verified evidence. It still compresses one leaf or merges two adjacent nodes and keeps the same turn system prompt/tools. No rigid metadata form or parallel authored note is required. These instructions affect future summaries only: existing summaries are not rewritten, and useful facts can still be omitted by a model.

## Validation and benchmarks

Run in the repository after installing its pinned dependencies:

```sh
npm run check
node --import tsx --import ./test/support.ts --test test/focus.test.ts test/zoom-navigation.test.ts test/summary-navigation.test.ts test/resolution-context.test.ts
npm run benchmark:resolution
npm test
npm run test:pi-compat
```

`benchmark:resolution` is a deterministic synthetic retrieval-policy replay using actual Memory/tool/context plumbing. It covers an old-topic return, reuse across refresh boundaries and a superseded decision. It reports tool calls, returned/detail bytes, median/p95 CPU times and stable-prefix bytes. Scripted fixture summaries and scripted navigation are explicitly **not** LLM reasoning or summary-fidelity evaluations. Prefix eligibility does not establish provider cache hits, savings, billed cost or end-to-end agent speed. Timing samples are descriptive rather than a raised pass threshold.

See [implementation ledger](../plans/resolution-on-demand.md) for exact results, failures and outstanding criteria. No live profile or provider is needed for these checks. Source changes require `/reload` or a new Pi session; neither this documentation nor the tests reload the running session.
