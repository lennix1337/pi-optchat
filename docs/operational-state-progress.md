# Structured operational state — implementation handoff

## Scope and status

Implemented the independent durable-state layer in `src/operational-state.ts`; focused tests are in `test/operational-state.test.ts`. This module does not interpret narrative text, call a model, grant authorization, or validate chat-message provenance. Parent-owned tool integration must validate `sourceMessageId` against the actual memory root and ensure authorization records come only from an explicit, user-authored authorization event.

## API contract

```ts
import {
  emptyOperationalState,
  readOperationalState,
  updateOperationalState,
  renderOperationalContext,
  OperationalUpdateSchema,
  type OperationalState,
  type OperationalUpdate,
} from './operational-state.ts';

const state = readOperationalState(file); // absent file -> empty v1 state; malformed file -> throw
const next = updateOperationalState(file, update); // validate, append, atomicWrite, return state
const promptSection = renderOperationalContext(next, 6_000); // capped at 8,000 chars
```

`sourceMessageId` is a required non-empty `string` (max 128 characters), intended to contain the message ID as a string. This layer only validates its shape; the parent must verify that the referenced message exists in the current memory root before writing. IDs are generated deterministically as `op_<24 lowercase hex chars>` from explicit entry content; callers cannot provide an ID. A duplicate update is idempotent. `supersedes` must identify an existing record of the same kind, is explicit, and never deletes history. A record may have only one successor.

Kinds: `objective`, `decision`, `constraint`, `authorization`, `change`, and `check`. A check must have status `verified`, `not_verified`, or `blocked`, plus 1–4 explicit evidence references. Other kinds do not have check status. Evidence kinds are `self-reported`, `test`, `log`, `tool-result`, and `external`; rendered evidence retains that label. A `change` record is not a check, and no implementation-to-verification promotion is inferred. A check marked `verified` cannot rely only on `self-reported` evidence. Rendered self-reports are explicitly marked as unverified assertions. Authorization entries preserve explicit source statements for continuity only; they are not a permission source and must not replace normal authorization checks.

The exported `OperationalUpdateSchema` is the exact TypeBox schema for the parent tool's update input. It disallows extra fields and requires `sourceMessageId`; the parent additionally validates that ID against live memory. Read/write validation is repeated in this module, independent of TypeBox. The proposed tool can expose `OperationalUpdateSchema` as the `update` argument and a separate `inspect` operation with no arguments; both should call the durable module rather than trust model-supplied state snapshots.

## Durability and bounds

- JSON version 1; strict shape, stable-ID/content consistency, unique IDs, valid same-kind supersession references, and cycle/branch checks.
- Missing file reads as empty state; malformed, oversized, or unsupported-version state throws and is not overwritten.
- `atomicWrite` from `src/store.ts` is used for persistence. Failed writes propagate; no new state is returned and the previous file remains intact.
- At most 256 entries and 256 KiB on disk; record text is at most 2,000 chars, source ID 128 chars, and evidence is at most four 256-char references.
- Model context includes only current (not superseded) records, prioritizes objective/constraints/authorization/checks, labels source IDs and evidence, and has a hard 8,000-char maximum (6,000 by default). If any record is omitted, an explicit truncation marker is guaranteed, including at the minimum 128-char render budget. Full history stays on disk.

## Parent integration proposal

Use an `operational_state` tool with an explicit `operation` discriminator (`inspect` or `update`). For `update`, use the exported `OperationalUpdateSchema` for the update payload; call `updateOperationalState` only after checking `sourceMessageId` against the current memory root and confirming its author/role as appropriate. For `inspect`, call `readOperationalState`. Add `renderOperationalContext` to the parent-selected context with the bounded default. Do not treat persisted authorization as live authority, and do not convert a `change`/implementation record into a verified check.

## Validation

Focused state tests pass 8/8; combined state/recovery tests pass 13/13; Pi 1.2 runtime compatibility tests pass 2/2. The latest workspace typecheck reports unrelated concurrent errors at `src/index.ts:246` (too many arguments for a constructor) and `test/compactor-diagnostics.test.ts:199` (fixture `phase` widened to `string`); this module has no TypeScript diagnostics. Ripwire edit-check passes; quality-delta exits 2 due to 17 shared pre-existing/ambient gating findings, with no finding on this implementation after splitting validators and reusing the existing `record` helper. Test-gate identifies the parent-owned `index.ts` tool caller as untested; the corresponding tests should exercise `operational_state` through the live Pi tool. The separate Pi 1.2 runtime registration test passes but does not invoke that tool. Tests cover append/idempotency/lineage, required source/evidence/status, self-report not establishing verification, distinct change vs verified check, no prose-to-authorization inference, malformed persistence preservation, atomic-write failure preservation, and explicit bounded truncation.
