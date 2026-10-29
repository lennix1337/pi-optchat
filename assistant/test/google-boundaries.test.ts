import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ACCOUNTS, MAIL_SCOPE, hour, withGoogle, type FixtureMessage } from './google-support.ts';

const mail = (id: string, receivedAt: string, extra: Partial<FixtureMessage> = {}): FixtureMessage => ({ id, from: 'Ana <ana@example.test>', subject: `Subject ${id}`, body: `Body ${id}`, receivedAt, ...extra });

test('mail is read across every page in order, and a page token loop is refused', () => withGoogle(async ({ google, connect, fake }) => {
  for (let i = 1; i <= 5; i++) fake.mail.personal.push(mail(`m${i}`, `2026-10-28T0${i}:00:00.000Z`));
  await connect('personal', 'personal');
  const read = await google.listMessages('personal');
  assert.deepEqual(read.items.map(m => m.ref.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(read.truncated, false);
  assert.deepEqual(fake.requests('/gmail/v1/users/me/messages').filter(r => r.path.endsWith('/messages')).map(r => r.params.pageToken ?? null), [null, '2', '4']);
  assert.deepEqual(read.items[0].ref, { connectionId: 'personal', account: ACCOUNTS.personal.email, kind: 'gmail.message', id: 'm1' });
  assert.equal(read.items[0].from, 'Ana <ana@example.test>');
  assert.equal(read.items[0].receivedAt, '2026-10-28T01:00:00.000Z');
  fake.loopPageToken = true;
  await assert.rejects(google.listMessages('personal'), /google_pagination_loop/);
}));

test('retention bounds: lookback window, message count, body length; older mail is dropped even if returned', () => withGoogle(async ({ open, connect, fake, clock }) => {
  const google = open({ retention: { mailLookbackDays: 1, maxMessages: 3, maxBodyChars: 10 } });
  fake.mail.personal.push(mail('old', '2026-10-26T12:00:00.000Z'), mail('m1', '2026-10-28T01:00:00.000Z', { body: 'x'.repeat(50) }), mail('m2', '2026-10-28T02:00:00.000Z'), mail('m3', '2026-10-28T03:00:00.000Z'), mail('m4', '2026-10-28T04:00:00.000Z'));
  await connect('personal', 'personal', google);
  const read = await google.listMessages('personal');
  assert.equal(fake.requests('/gmail/v1/users/me/messages')[0].params.q, `after:${Math.floor((clock.now - 24 * hour) / 1000)}`);
  assert.deepEqual(read.items.map(m => m.ref.id), ['m1', 'm2', 'm3'], 'the fake ignores the query; the connector still drops old mail');
  assert.equal(read.truncated, true, 'more mail existed beyond the count bound');
  assert.equal(read.items[0].body, 'x'.repeat(10));
  assert.equal(read.items[0].bodyTruncated, true);
  assert.equal(fake.requests('/gmail/v1/users/me/messages/m4').length, 0, 'nothing beyond the bound is fetched');
  for (const retention of [{ maxMessages: 0 }, { mailLookbackDays: 365 }, { maxBodyChars: 1e9 }, { maxPages: -1 }]) assert.throws(() => open({ retention }), /invalid_options/);
}));

test('attachments are metadata only: never downloaded, executables flagged', () => withGoogle(async ({ google, connect, fake }) => {
  fake.mail.personal.push(mail('a1', '2026-10-28T08:00:00.000Z', { attachments: [
    { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1200 },
    { filename: 'update.EXE', mimeType: 'application/octet-stream', size: 90000 },
    { filename: 'run.ps1', mimeType: 'text/plain', size: 30 },
    { filename: 'macro.docm', mimeType: 'application/vnd.ms-word.document.macroEnabled.12', size: 3000 },
    { filename: 'innocent.txt', mimeType: 'application/x-msdownload', size: 10 },
    { filename: 'photo.jpg.lnk', mimeType: 'application/octet-stream', size: 10 },
  ] }));
  await connect('personal', 'personal');
  const [message] = (await google.listMessages('personal')).items;
  assert.deepEqual(message.attachments.map(a => [a.filename, a.executable]), [['invoice.pdf', false], ['update.EXE', true], ['run.ps1', true], ['macro.docm', true], ['innocent.txt', true], ['photo.jpg.lnk', true]]);
  assert.equal(message.body, 'Body a1');
  assert.ok(!JSON.stringify(message).includes('attachmentId'), 'no handle to fetch attachment bytes is exposed');
  assert.equal(fake.log.filter(r => r.path.includes('/attachments')).length, 0);
}));

test('calendar: local dates in the profile time zone, all-day dates unshifted, recurring instances expanded, cancelled skipped, all pages', () => withGoogle(async ({ google, connect, fake }) => {
  fake.events.personal.push(
    { id: 'late', summary: 'Late call', status: 'confirmed', updated: '2026-10-20T00:00:00.000Z', start: { dateTime: '2026-10-29T01:30:00Z' }, end: { dateTime: '2026-10-29T02:00:00Z' } },
    { id: 'offset', summary: 'Berlin sync', status: 'confirmed', updated: '2026-10-20T00:00:00.000Z', start: { dateTime: '2026-10-28T15:00:00+01:00', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-10-28T16:00:00+01:00' } },
    { id: 'holiday', summary: 'Holiday', status: 'confirmed', updated: '2026-10-20T00:00:00.000Z', start: { date: '2026-10-28' }, end: { date: '2026-10-29' } },
    { id: 'standup_20261028', recurringEventId: 'standup', summary: 'Standup', status: 'confirmed', updated: '2026-10-20T00:00:00.000Z', start: { dateTime: '2026-10-28T12:00:00Z' }, end: { dateTime: '2026-10-28T12:15:00Z' } },
    { id: 'standup_20261028T200000Z', recurringEventId: 'standup', summary: 'Standup (moved)', status: 'cancelled', updated: '2026-10-27T00:00:00.000Z', start: { dateTime: '2026-10-28T20:00:00Z' }, end: { dateTime: '2026-10-28T20:15:00Z' } },
  );
  fake.masters.personal.push({ id: 'standup', summary: 'Standup', recurrence: ['RRULE:FREQ=DAILY'], start: { dateTime: '2026-10-01T12:00:00Z' } });
  await connect('personal', 'personal');
  const read = await google.listEvents('personal', { from: '2026-10-28T03:00:00.000Z', to: '2026-10-29T03:00:00.000Z', timeZone: 'America/Sao_Paulo' });
  const request = fake.requests('/calendar')[0].params;
  assert.equal(request.singleEvents, 'true');
  assert.equal(request.timeZone, 'America/Sao_Paulo');
  assert.equal(request.timeMin, '2026-10-28T03:00:00.000Z');
  assert.equal(fake.requests('/calendar').length, 3, 'five instances in pages of two');
  assert.deepEqual(read.items.map(e => [e.ref.id, e.localDate, e.localStart, e.allDay, e.recurring]), [
    ['late', '2026-10-28', '22:30', false, false],
    ['offset', '2026-10-28', '11:00', false, false],
    ['holiday', '2026-10-28', null, true, false],
    ['standup_20261028', '2026-10-28', '09:00', false, true],
  ]);
  assert.equal(read.items[0].start, '2026-10-29T01:30:00.000Z');
  assert.equal(read.items[2].start, '2026-10-28');
  await assert.rejects(google.listEvents('personal', { from: '2026-10-28T03:00:00.000Z', to: '2026-10-29T03:00:00.000Z', timeZone: 'Mars/Olympus' }), /invalid_range/);
  await assert.rejects(google.listEvents('personal', { from: '2026-10-29T03:00:00.000Z', to: '2026-10-28T03:00:00.000Z', timeZone: 'UTC' }), /invalid_range/);
}));

test('a source read without its granted scope is refused before any request', () => withGoogle(async ({ google, connect, fake }) => {
  fake.grantedScopes = ['openid', 'email', MAIL_SCOPE];
  await connect('personal', 'personal');
  const before = fake.log.length;
  await assert.rejects(google.listEvents('personal', { from: '2026-10-28T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z', timeZone: 'UTC' }), /google_scope_missing/);
  assert.equal(fake.log.length, before);
}));

test('an API failure is a coded error without response content', () => withGoogle(async ({ google, connect, fake }) => {
  await connect('personal', 'personal');
  fake.failures.set('/gmail/v1/users/me/messages', 500);
  await assert.rejects(google.listMessages('personal'), error => (error as Error).message === 'google_request_failed');
}));

const draftMessage = { kind: 'message' as const, connectionId: 'personal', to: ['Bia@Example.test', 'carl@example.test'], subject: 'Lunch', body: 'Thursday at noon?' };
const write = (operationId: string, now: number) => ({ operationId, sessionId: 's', taskId: 't', runId: 'r', policyVersion: 'v1', expiresAt: now + hour });

test('a draft is a preview: the exact account, destination and content a send would carry', () => withGoogle(async ({ google, connect }) => {
  await connect('personal', 'personal');
  const preview = google.preview(draftMessage);
  assert.deepEqual(preview, {
    action: 'gmail.send', account: ACCOUNTS.personal.email, destination: 'bia@example.test,carl@example.test',
    content: JSON.stringify({ body: 'Thursday at noon?', subject: 'Lunch', to: ['bia@example.test', 'carl@example.test'] }),
    contentHash: createHash('sha256').update(JSON.stringify({ body: 'Thursday at noon?', subject: 'Lunch', to: ['bia@example.test', 'carl@example.test'] })).digest('hex'),
  });
  const event = google.preview({ kind: 'event', connectionId: 'personal', calendarId: 'primary', summary: 'Dentist', start: '2026-10-30T13:00:00-03:00', end: '2026-10-30T14:00:00-03:00', attendees: [] });
  assert.equal(event.action, 'calendar.insert');
  assert.equal(event.destination, 'calendar:primary');
  assert.deepEqual(JSON.parse(event.content), { attendees: [], calendarId: 'primary', end: '2026-10-30T17:00:00.000Z', start: '2026-10-30T16:00:00.000Z', summary: 'Dentist' });
  for (const bad of [{ ...draftMessage, to: [] }, { ...draftMessage, to: ['not an address'] }, { ...draftMessage, subject: 'a\r\nBcc: x@example.test' }, { ...draftMessage, connectionId: 'other' }]) assert.throws(() => google.preview(bad), /invalid_draft|google_connection_unknown/);
}));

test('sending goes only through the gateway: without the exact grant for account, destination and content nothing is dispatched', () => withGoogle(async ({ google, connect, gateway, authority, clock }) => {
  await connect('personal', 'personal');
  await connect('dentai', 'dentai');
  const sent: unknown[] = [];
  const sink = (bytes: Uint8Array, metadata: { account: string; destination: string }) => { sent.push({ content: Buffer.from(bytes).toString(), account: metadata.account, destination: metadata.destination }); return 'sent'; };

  await assert.rejects(google.send(draftMessage, write('op-1', clock.now), sink), /approval_required/);
  assert.equal(sent.length, 0, 'no grant, no dispatch');

  const review = google.prepareSend(draftMessage, write('op-1', clock.now));
  assert.equal(review.decision, 'review');
  if (review.decision !== 'review') return;
  assert.equal(review.metadata.account, ACCOUNTS.personal.email);
  assert.equal(review.metadata.destination, 'bia@example.test,carl@example.test');
  assert.equal(Buffer.from(review.payload).toString(), google.preview(draftMessage).content);
  gateway.decide(review.reviewId, 'approve', authority);

  for (const changed of [{ ...draftMessage, body: 'Friday instead?' }, { ...draftMessage, to: ['bia@example.test'] }, { ...draftMessage, connectionId: 'dentai' }]) {
    await assert.rejects(google.send(changed, write('op-1', clock.now), sink), /approval_required/, JSON.stringify(changed));
  }
  assert.equal(sent.length, 0);
  assert.equal(await google.send(draftMessage, write('op-1', clock.now), sink), 'sent');
  assert.deepEqual(sent, [{ content: google.preview(draftMessage).content, account: ACCOUNTS.personal.email, destination: 'bia@example.test,carl@example.test' }]);
  await assert.rejects(google.send(draftMessage, write('op-1', clock.now), sink), /operation_already_dispatched/);
  await assert.rejects(google.send(draftMessage, write('op-2', clock.now), sink), /approval_required/, 'the grant was single-use');
  assert.equal(sent.length, 1);

  await google.revoke('personal', authority);
  assert.throws(() => google.prepareSend(draftMessage, write('op-3', clock.now)), /google_connection_revoked/);
}));
