# Reliability and performance implementation plan

Goal: improve execution diagnostics, context efficiency, startup, recovery resilience, and offline regression coverage without changing authorization or replay safety.

Architecture: preserve existing journals/projections; add focused regression coverage before changing behavior. Benchmark local overhead separately from provider latency. No paid inference, account switching, Git publication, or unrelated changes.

## Acceptance and evidence
- [x] Reliability diagnostics verified: durable timestamps/dispatch marker, real Pi tool-loop/file readback, reopening and replay-barrier tests. Native dump metadata reader tested and installed. Root uncertainty/native corrupting component not verified; debugger/symbols unavailable.
- [x] Context: immutable unhelpful previews analyzed once; paired repeated-projection median 0.581949 to 0.000134 ms, same original object/content. Optional numeric payload measurements default off; serialization failures do not alter/block payload.
- [x] Startup profiling: candidate deferred imports measured <1% difference, reverted. Final current/baseline imports varied +6.4%; no startup gain claimed. Loader and Pi lifecycle checks pass.
- [x] Recovery: explicit policy-stop code gap reproduced and fixed; real synthetic-provider Pi quota/refusal tests pass. PMA full suite 728 pass/1 skip, typecheck pass; live OAuth/quota state unverified, no account access/switching.
- [x] Benchmarks: test:reliability, benchmark:reliability, PMA test:recovery, safe crash-reader tests. Fresh-process Pi skill discovery verified expanded triggers, zero diagnostics; source in dotfiles.

## Execution
1. Read current implementations/tests and preserve dirty source.
2. Capture reproducible baselines outside Git.
3. Add failing focused tests, implement smallest fixes, verify red/green.
4. Run typecheck, relevant tests, full suite where feasible, Pi runtime compatibility and Ripwire checks.
5. Document measured results/limits, mirror changed Pi tooling to dotfiles without committing.

Final state: implementation and offline verification recorded in docs/reliability-performance.md; raw logs/baseline under ignored scratchpad/reliability-performance. OptChat full suite478 pass/1 skip, compatibility2/2; reliability26/26; PMA728 pass/1 skip and recovery7/7; metadata4/4. Focused edit checks pass; OptChat whole-dirty quality remains18 major and test-gates4, PMA quality0/gate4, dotfiles quality0/gate0. Preexisting edits preserved. No commit/push/publication or paid inference. Next required live step: /reload. Native root cause needs debugger/symbols; current crash reader proves only exception-site metadata. Recurring harness uncertainty is not fixed or attributed.
