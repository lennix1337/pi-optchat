---
name: personal-assistant
description: Use the optional personal-assistant inbox to list or inspect tasks, respond to input, or inspect evidence and originals.
---

The server is optional and starts only with explicit operator permission. The operator supplies its secret config outside Git; do not put tokens in arguments or logs. See the repository README and `node assistant/src/main.ts --help` for manual setup. The active owner profile has its own `assistant.json` client config.

- `/assistant local [cursor]` pages read-only metadata from the current session’s approval, operation and agent journals, plus profile-scoped external agents; no service config or network is needed. It grants or reconciles nothing.
- `/assistant list [cursor]` shows the first local page plus optional service snapshots; `/assistant show <id>` shows one task and local attention counts.
- `/assistant respond <id>` prompts interactively for the current input request. If the outcome is uncertain, inspect state before further action; do not automatically retry.
- `/assistant evidence <id> [afterSequence]` lists references; `/assistant original <id> <eventSequence> [offset]` opens a supported local historical original. IDs and cursors are URL-encoded.

Snapshots, responses and evidence are metadata, not authorization or proof of successful work. Reading does not resolve a task or approve an effect.
