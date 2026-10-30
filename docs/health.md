# Jarvis health and cached quota

In an open OptChat profile with `assistant.json`, `/optchat-health` runs the registered monitors and displays their persisted state. Automatic rounds start after one minute, then run every five minutes. The morning summary includes production, this PC and model quota.

Quota reads only `provider-failover-state.json` in `PI_CODING_AGENT_DIR` (default `~/.pi/agent`). It never calls providers, reads credentials, switches accounts or changes failover state. `pi-multi-account` continues to own routing and recovery.

- The fullest unexpired primary/secondary window describes each measured account. A current provider cooldown also counts as exhausted.
- At 90% or more, a still-serving account enters the morning forecast. Reset times use Brasília time.
- Only exhaustion of every **monitored** account fails the probe. Two failed rounds produce one DM alert, without a model wake; recovery posts once.
- Missing, malformed or expired readings mean availability is unknown, not that every account is available. Cached usage is an estimate, not a live request or proof that an unmetered provider works.

Runtime files stay in the profile, outside Git: `prod-health.json`, `pc-health.json`, `quota-health.json`, and `self-fixes.json`. Production outage notifications route to `#dentai`; PC and quota route to the operator's DM. A real PC remedy is separate from quota: disk/maintenance failures can start the existing scheduled maintenance task; quota never starts a process.

Validation: inspect `.pi/checks.json`, then run the `quota-health` recipe. It uses disposable cache/profile files to verify boundary cases, registered routing, persistence, recovery and summary output without provider calls. Reload is needed to activate changed monitor registration; a passing offline check is not proof of live scheduling or Slack delivery.
