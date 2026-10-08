# OptChat recipe reference

Author: Victor Taelin.

Source: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

The implementation was compared with the recipe fetched on 2026-10-04. The reference content SHA-256 was `8f6997e8944d85e4df53b5704bf7c4e393e4da361071181e9cc2f7d9d1b6e430`.

The source remains upstream rather than duplicating the full article here. Its system prompt, from the 2026-10-08 revision, is in `src/recipe-prompt.ts` with the small adaptations the README lists (the subagent prompt, from the original, is in `src/prompts.ts`), and attribution in `THIRD_PARTY_NOTICES.md`.

## Implementation mapping

- `src/recipe-prompt.ts`: the one system prompt for turns and compactions (§5).
- `src/memory.ts`: append-only log, binary summary tree, compression scheduling (§4: a message's node starts once fewer than 8 lines before it are unbuilt, a merge once both halves are built, kept in queues so the tree is never scanned for work; a failed call is tried again at the next message; an import, with no next message, also after 10 seconds), the compactions' own view (§4: the view merged further to 16,000-32,000 bytes, ending at the node and stopping at the first unbuilt line), the view (§3.2: the most due pair, measured from its last message, merges in one batch from 128,000 down to 64,000 bytes, and the view is saved to `view.json` rather than refolded at start), zoom/date, and the opt-in text search over original messages (not in the recipe, off by default).
- `src/compactor.ts`: a compaction is a call like a turn (§4): the turns' system prompt and tools once a turn has built them (the recipe's prompt alone before that), then the compactions' view and the recipe's task with its 512-dash ruler and "Too long" retry, verbatim. The view shows each line under its `id+n|` head, so a reply that copies a head has it removed.
- `src/cache.ts`: Anthropic cache marks: the view in blocks of 4 lines, one mark on the last whole block and one at the request's end, as in §3.3, plus two marks 20 and 40 blocks before the last. OpenAI requests get no marks and rely on implicit prefix caching.
- `src/transcript.ts`: a fresh context per turn (§6): the view, per-turn state after it (Pi's working-directory section, moved out of the system prompt), then the new message; long texts logged as several messages in a row (§1). The previous exchange is replayed only with that setting on.
- `src/tools.ts`: `zoom(id, n)`, `zoom(agent)` for a subagent's whole chat, `date(id)`.
- `src/agents.ts`: asynchronous Pi SDK children and automatic completion reports as `work` messages.
- `src/settings.ts`: per-profile settings for what the recipe leaves out. Every default is the recipe's.
- `src/import/`: profile-scoped historical imports; an integration choice. An import hands `Memory` one message at a time, each once the one before it is summarized.

Profiles, native Pi UI, conversation import, and local Git checkpoints are integration choices described in the README.
