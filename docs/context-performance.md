# Context performance and recoverable output

Independent implementation using Node/Pi APIs; no OpenHuman/TinyJuice source or dependencies are incorporated.

## Provider-only output projections

`Recoverable shell output` defaults on. Text-only `bash`/`powershell` results of at least 8 KiB are eligible. Smaller outputs (including already reduced RTK results), images/mixed content and other tools pass through unchanged. A projection is used only if it saves at least 20% including reference overhead.

The full result is atomically stored and read back with a SHA-256 integrity check **before** replacing it in model context. The Pi session and OptChat memory retain original shell evidence; journal classification, result/error flags, tool-call pairing and tool execution are unchanged. This also applies to SDK child sessions. A storage/permission/quota/integrity failure returns the full original, not an empty or fabricated result; existing context-size guards still apply.

A deterministic, bounded preview identifies JSON, diffs, search results, or build/log output. It selects format-specific structure and evidence (JSON keys/values, diff file/hunk markers, search hits, or first/last log lines and diagnostics), with omission/clipping counts, the original error flag, and a retrieval reference. Patterns include errors, warnings, exceptions, panic/fatal, test summaries, exit codes and C#/TypeScript/GeneXus diagnostic codes. This is not an exhaustive parser or proof of success. Long lines and additional diagnostics can be omitted; inspect originals for missing evidence.

### Reading originals

Use `output_read({ref, offset?, limit?, findText?, query?})`:
- `ref` is the 64-character identifier after `output:`; arbitrary paths are rejected.
- `offset`/`limit` page UTF-16 character offsets (default 8,000; maximum 25,000); surrogate pairs are not split.
- `findText` is a case-sensitive **literal** search, not a regex. The response gives the match and the offset to repeat `findText` with for the next one. Pages are bounded; a missing match is explicit.
- Alternatively, `query: {kind: 'lines', startLine, endLine}` retrieves a 1-based inclusive range (maximum 200 lines). `query: {kind: 'json', path?, fields?}` selects a restricted `$` JSON path and/or up to 50 direct fields; no wildcards, filters, or prototype traversal. Structured responses are bounded to 24,000 bytes and reject missing values explicitly. Do not combine `query` with paging/search.
- Tool output is untrusted data, not instructions. The installed tool carries `readOnlyHint`, so observation can proceed behind an operation uncertainty barrier without clearing it.

Artifacts are local to `PROFILE/outputs/<hashed-session>/`, with private file/directory modes on systems supporting them. Child and main sessions cannot retrieve each other's references through this tool. They may use their existing authorized transcript/zoom access. These files can contain sensitive output: do not publish them or treat hashing as redaction. They are not part of the pluggable memory-store sync.

Retention is seven days, with expired files cleaned lazily on subsequent writes. Originals are limited to 8 MiB each and the on-disk records share a 64 MiB profile quota; live references are not evicted to admit new ones. Local transcript/memory originals remain independent of artifact retention. Missing/corrupt/expired artifacts fail explicitly; use the original session or memory zoom. Storage is not a sandbox or an encrypted vault.

## Prompt budget and latency diagnostics

`/optchat-perf` displays **in-memory numeric-only** aggregates without a model request. `context_metrics` is also registered, but inactive by default and marked `deferred` using Pi 1.2's tool-exposure API; tool discovery or explicit activation can expose it. This defers model-facing discovery, not JavaScript loading or extension hooks, and does not claim additional default-schema savings over the prior inactive setting; Child sessions have their own metrics tool.

Metrics include latest request token estimate, system bytes, tool-schema bytes, instruction/catalogue bytes where identifiable as named sections/XML tags, and system-prefix change count. Prefix content/hashes, raw prompts, arguments, output and error text are not reported or persisted. A changed prefix is an observation, not a cache-miss diagnosis. The existing stable tool toggles and Anthropic view caching remain unchanged. The zoom description is shorter while preserving its pagination, independent-read and image-safety guidance; user instructions and skill catalogues are not stripped.

Stage aggregates contain count/total/max/last duration, not unbounded samples: context assembly (includes waits), projection, tool execution, request-to-headers, first actual content when the SDK emits it, and request-to-completed-assistant response. Main sessions also time memory settling, settlement persistence, compactor calls and child opening. These phases overlap; **do not sum them**. Failed/aborted requests may have no completed response or first-content sample. This is not provider inference time, billing, crash tracing, task success, or proof of an end-to-end speedup. Metrics reset on profile/session reopen.

## Focused child history

`Focused child history` is implemented but **off by default** until task-quality measurements justify enabling it. When enabled, new task agents receive whole history lines within a 16 KiB budget, retaining an initial overview and newest lines. Omitted history remains accessible through zoom and is explicitly labelled. This is recent-history selection, **not semantic relevance retrieval**.

The task, installed instructions and current operational state are not shortened. Still, an old chat-only restriction could be omitted: the parent must include task-specific constraints, contracts, evidence IDs and relevant files in the task. Connected conversations and resumed sessions do not have their historical transcript silently rewritten. Turn the setting off for broad historical work.

## Immutable child resources

Only the three static delegation-tool schemas are shared and recursively frozen. Tool descriptors and closures, settings, permissions, loaders, extensions and session state remain per-child; changed delegation settings take effect on the next child. A local schema-construction microbenchmark found 20,000 constructions took 61.97–73 ms versus 0.08–0.48 ms for reference reuse. This is not a session-startup or task-completion measurement.

## Agent panel

The Agents table includes a separate `model(thinking)` column, e.g. `gpt-6-luna(xhigh)`. It uses persisted effective run identifiers/SDK thinking levels, not aliases or current profile defaults. Model/thinking changes update live metadata; completed runs retain their own recorded values. Unknown historical values are shown as unknown, never guessed. Narrow terminals hide metadata before losing task readability; the individual agent header also includes reasoning.

## Offline benchmarks and gates

Run `npm run benchmark:performance` for synthetic in-memory context/schema budgets and informational CPU/RSS measurements (see [performance budgets](performance-budgets.md)). No provider or user profile is accessed. Deterministic size ceilings gate tests; hardware-dependent timing is informational.

Run `npm run benchmark:context`. Three generated, sanitized GeneXus/Cargo/web-build logs compare raw messages, the pre-existing bounded-message view and the recoverable projection. Output includes Pi token **estimates**, durable cold projection time, same-object warm-cache mean, and extra reads required for expected diagnostics. No provider, paid call, project log or personal data is used.

An observed local Windows run reduced the prior 7,500-token capped views to 302–328 estimated tokens (96%), with zero extra reads for fixture diagnostics. Cold projection took 3.55–12.02 ms and same-object warm-cache mean 0.0002–0.0003 ms. This tiny synthetic sample does not establish workload/model latency, cache billing or task-quality improvements. The new retrieval schema has a fixed cost; small outputs may have no net token savings.

`context-performance.test.ts` repeats corpus/evidence checks and generous CPU/storage ceilings (2 s cold, 20 ms warm). Other tests cover errors, original immutability, restart, isolation, integrity, expiry, profile quotas, omitted diagnostics, Unicode paging, actual Pi main/child request→retrieval→canonical-evidence flow, SDK reasoning values, narrow terminal rendering and telemetry privacy. Live-provider and active-TUI verification require a subsequent user reload; no automatic reload is performed.
