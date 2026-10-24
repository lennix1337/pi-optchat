# Mechanical effect approvals — implementation record

Operator-facing contract, limits and checks: [effect-approvals.md](effect-approvals.md).

## Status

- [x] Regression-first unit tests (`test/authorization.test.ts`): the module was absent, then the project-checks listing admitted execution; both failed before the fix. The child-grant and reconciliation-write regressions also failed first (receipt `5984fc4f`).
- [x] `src/authorization.ts` exact-invocation gate and `src/authorization-hooks.ts` native wiring; no model-callable grant tool.
- [x] Registered in the parent and in OptChat children. Children use `grant: false` because SDK `prompt`/`steer` default manager-authored input to `interactive`; found by independent review.
- [x] Mutation proof on disposable copies: provenance, owner, one-shot use and admission guards are each killed.
- [x] Installed Pi 1.4.0 SDK runtime probe: refusal → hidden/prose tokens refused → interactive token → one disk write → replay refused → reload invalidates → delegated `steer` cannot grant. Network rejected, scripted provider.
- [x] Packaged `effect-approvals` skill, discoverable in a fresh isolated profile.
- [ ] Activation in the operator's interactive profile (`OPTCHAT_EFFECT_APPROVALS=1` + restart) — operator decision, not automatic.
- [ ] Reusable scoped standing grants (for example push to fork `main` after green gates, this goal's paid calls), so authorized routine work does not need a token per call.
- [ ] Direct provider/paid-call interception outside tool dispatch.
