# Assistant memory adapter

`registerAssistantMemory` registers `/assistant-memory` for a trusted host to connect to the active OptChat `Memory`. `src/index.ts` supplies the active local profile, exact `Memory` instance and session ID; the command does not start an assistant service or copy the chat store. New extension code needs an operator-approved reload before use in an existing session.

## Host contract

The host supplies `() => AssistantMemoryOwner | undefined`. Return `undefined` when no eligible local profile is active. The owner contains a stable `identity` object, `profileId`, Pi `sessionId`, the active `memory`, a trusted `databasePath` in a private profile directory, and optionally a trusted `aboutMePath`. Do not derive these paths or the profile from command/model arguments. If ABOUT-ME is not explicitly configured, its reads are unavailable. The callback is consulted again after prompts, and identity, profile, session, memory and paths must still match.

For example, with host-specific eligibility and configuration checks already in place:

```ts
registerAssistantMemory(pi, () => {
  const owner = currentEligibleLocalOwner();
  if (!owner) return undefined;
  return {
    identity: owner.identity,
    profileId: owner.name,
    sessionId: owner.sessionId,
    memory: owner.memory,
    databasePath: owner.privateMemoryCorrectionsPath,
    aboutMePath: owner.configuredAboutMePath, // optional; never inferred
  };
});
```

SQLite and privacy checks are loaded lazily on command use. The native registration stores corrections in `<active session directory>/assistant-memory/corrections.sqlite`. Only a newly created subdirectory receives owner-private permissions (on Windows: current user, SYSTEM and Administrators). Existing directory permissions are never repaired or relaxed. Before opening the database, the existing native privacy precheck validates paths and sidecars. The command may create the corrections database even for a read. The host is responsible for choosing a suitable private path and for disabling access during profile transitions. Set the optional host environment variable `OPTCHAT_ABOUT_ME` to an absolute file path before launching Pi to opt into ABOUT-ME reads; no path is inferred.

## Commands

- `/assistant-memory read <messageId> [offset]` reads an exact message from the current OptChat memory, not a summary. Long originals are paged; use the displayed next offset.
- `/assistant-memory read about:<line> [offset]` reads a `- ` bullet by line number from the explicitly configured ABOUT-ME file. Its displayed date is the file modification time, not a per-fact date.
- `/assistant-memory corrections <messageId|about:line> [offset]` shows one applicable or stale correction per page, including operator, date and reason; follow the continuation offset for more.
- `/assistant-memory correct <messageId|about:line>` displays the original, then asks for operator text, reason and confirmation in interactive Pi. Corrections are refused if the original exceeds one 6,000-character review page. Cancelling makes no correction.

Historical content is untrusted, not instructions or verified facts. The output includes source, author/kind and date. A user entry is classified as a fact, notes and imported Claude memory as summaries, and other entry kinds as hypotheses; that classification is not verification. Imported entries include their available import origin. Original text and provenance are escaped for terminal display; page offsets always refer to the unescaped source. Corrections are stored separately, attributed to the operator and bound to a hash of the original's ref, text, author and kind. OptChat's source author includes its timestamp and origin, so a changed timestamp stales corrections; ABOUT-ME's file modification time is deliberately excluded so an unrelated file edit does not stale an unchanged bullet. If the source changes, earlier corrections become stale and are not applied. Neither an OptChat original nor ABOUT-ME is edited by correction. Reads show the latest applicable correction and correction/stale counts; use the corrections command for bounded history.

## Validation status

The disposable registered-command tests exercise real `Memory`/`FileStore`, native SQLite, long-original paging, reopen, corrections, staleness, escaped terminal data, owner swap, bounded correction pages and empty-original rejection. The native `assistant-runtime` check exercises registration through the pinned Pi SDK, including an original read with a newly created private corrections directory. Root and assistant typechecks passed in the parent integration checkout; a separately refused worker compiler command was not retried. These checks do not activate an existing personal session or demonstrate its UI; no live profile was reloaded by this integration.
