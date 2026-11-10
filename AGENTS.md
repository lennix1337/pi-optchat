# pi-optchat

- For agent-requested reload, automatic continuation, or interrupted reload recovery, read `skills/self-reload/SKILL.md`. Preserve native lifecycle APIs and extension-message provenance; validate using the offline checks before active-session use.
- For the optional task inbox, exact memory originals/corrections, isolated offline previews or granted public HTTPS browser reads, Pi Voice panel or assistant-server operation, read `skills/personal-assistant/SKILL.md`. Starting a personal service/configuration is separate from offline validation.
- For Jarvis health probes, cached quota or the morning forecast, read `skills/personal-assistant/SKILL.md` → “Jarvis health and quota”.
- Check recipes live in `.pi/checks.json`; inspect before executing. Runtime receipts belong outside this repository.
- Production host look (read-only, one ssh session, no personal data): `node scripts/prod-check.mjs [--host hetzner-dentai|producao-dentai|all] [--since MIN] [--json]`; flat output ending `rc:` (0 healthy, 1 problems, 3 could not check). Use it instead of hand-built ssh calls for uptime, docker, nginx 5xx, TTFB, probes, disk.
