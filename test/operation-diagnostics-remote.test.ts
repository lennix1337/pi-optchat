import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyDiagnostic } from '../src/operation-diagnostics.ts';

test('docker inspections and ssh to a host running one are read-only; anything that runs or changes is not', () => {
  for (const command of [
    "docker ps --format '{{.ID}} {{.Names}}' | head -20",
    'docker stats --no-stream',
    'docker logs --tail 50 api',
    'docker inspect api',
    "ssh -o BatchMode=yes hetzner-dentai 'docker ps --format \"{{.Names}} {{.Status}}\" | grep -E \"front|api\"'",
    "ssh hetzner-dentai 'cat /etc/os-release'",
  ]) assert.equal(isReadOnlyDiagnostic('bash', { command }), true, command);
  for (const command of [
    'docker exec api sh', 'docker run alpine', 'docker rm api', 'docker logs -f api', 'docker compose up', 'docker ps *',
    "ssh hetzner-dentai 'docker restart api'", "ssh hetzner-dentai 'touch x'", 'ssh hetzner-dentai', 'ssh -o ProxyCommand=evil host ls',
    "ssh -L 80:x:80 host 'ls'", "ssh hetzner-dentai 'cat x > y'", "ssh -o BatchMode=yes -- host 'ls'",
  ]) assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
});
