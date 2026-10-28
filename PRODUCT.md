# OptChat optional personal assistant

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The operator of this Pi/OptChat profile, reviewing work, answering current input requests and finding original evidence. This describes the optional assistant surface, not a replacement for the canonical chat.

## Product Purpose

Expose the same profile-bound tasks and event journal in terminal and web. A response changes the current task; inspecting evidence changes nothing. Execution, verification and activation are separate facts.

## Operating Context

The accepted T01–T14 plan is docs/superpowers/plans/2026-10-28-personal-assistant-parity.md. T10 requires inbox, decisions, input responses, evidence, resumable events, keyboard use, light/dark themes and widths 360/768/1280. A desktop viewport does not prove a real phone.

## Capabilities and Constraints

Node HTTP and SQLite already own the contracts. The web channel is opt-in, loopback only and does not grant native approval authority. Real accounts, paid requests, autostart and personal service activation require separate permission. Never expose a token in a URL, log or persisted browser storage. No external fonts, imagery or new frontend dependencies are needed for this operating surface.

## Evidence on Hand

assistant/test contains native SQLite, policy and runtime proofs. External integrations and a real mobile device are not currently verified. Do not invent completed work or sample operator data in the shipped page.

## Product Principles

- Show what requires attention before completed work.
- Keep originals, task revisions and observed status explicit.
- Do not convert authenticated web intent into local-terminal approval.

## Open decisions

No product-wide brand or visual preference has been set. The initial panel uses a restrained working layout as an implementation assumption, not a saved operator preference. No commercial positioning, supported remote exposure or production readiness is implied.
