import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { bashIanaDate, registerBashTimezoneGuard } from '../src/bash-timezone.ts';

test('date with an IANA zone name is caught, since Git Bash has no zoneinfo and prints UTC', () => {
  const caught: [string, string][] = [
    // 04/11 22:00 BRT: this printed "05/11 00:56 BRT" for hours of reports.
    ['TZ=America/Sao_Paulo date "+%d/%m %H:%M BRT"; echo rc=$?', 'America/Sao_Paulo'],
    ['cd x && gh run list; TZ=America/Sao_Paulo date +%H:%M', 'America/Sao_Paulo'],
    ["TZ='Europe/Lisbon' date", 'Europe/Lisbon'],
    ['TZ="America/Argentina/Buenos_Aires" date -d @0', 'America/Argentina/Buenos_Aires'],
  ];
  for (const [command, zone] of caught) assert.equal(bashIanaDate(command), zone, command);
});

test('offset zones, UTC and other programs that read TZ themselves are left alone', () => {
  const fine = [
    "TZ='<-03>3' date '+%d/%m %H:%M'",
    'date -u +%H:%M',
    'TZ=UTC date',
    'TZ=America/Sao_Paulo node -e "console.log(new Date().toString())"',
    'echo "TZ=America/Sao_Paulo date"',
    "grep -n 'TZ=America/Sao_Paulo date' notes.md",
  ];
  for (const command of fine) assert.equal(bashIanaDate(command), undefined, command);
});

test('the hook refuses on Windows with the offset route, and stays off elsewhere', async () => {
  let hook: ((event: unknown) => unknown) | undefined;
  const pi = { on(_name: string, handler: (event: unknown) => unknown) { hook = handler; } } as unknown as ExtensionAPI;
  registerBashTimezoneGuard(pi, 'win32');
  const refused = await hook!({ toolName: 'bash', input: { command: 'TZ=America/Sao_Paulo date +%H:%M' } }) as { block: boolean; reason: string };
  assert.equal(refused.block, true);
  assert.match(refused.reason, /UTC/);
  assert.match(refused.reason, /TZ='<-03>3'/);
  assert.equal(await hook!({ toolName: 'read', input: { command: 'TZ=America/Sao_Paulo date' } }), undefined);

  hook = undefined;
  registerBashTimezoneGuard(pi, 'linux');
  assert.equal(hook, undefined);
});
