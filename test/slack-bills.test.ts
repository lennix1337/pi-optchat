import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { composeSummary } from '../src/slack-reports.ts';

const sources = [{ sourceId: 'pessoal:mail', state: 'ok' }];

test('the morning summary lists bills in the order the briefing gives, flagging the ones due soon or overdue', () => {
  const text = composeSummary({ day: [], waiting: [], prs: [], approvals: 0, briefing: { localDate: '2026-10-28', sources, items: [
    { section: 'bills', title: 'Fatura Fake - due 2026-10-25 - R$ 10,00', urgency: 'urgent', reason: 'bill_overdue' },
    { section: 'bills', title: 'Energia Fake - due 2026-10-30 - R$ 1.234,56', urgency: 'urgent', reason: 'bill_due_soon' },
    { section: 'bills', title: 'Net Fake - due 2026-11-05 - R$ 99,90', urgency: 'normal', reason: 'bill_upcoming' },
    { section: 'agenda', title: 'Reunião 10h', urgency: 'normal' },
  ] } });
  assert.match(text, /\*Contas a pagar\*\n• ⚠️ Fatura Fake - due 2026-10-25 - R\$ 10,00 \(vencida\)\n• ⚠️ Energia Fake - due 2026-10-30 - R\$ 1\.234,56\n• Net Fake - due 2026-11-05 - R\$ 99,90/);
  assert.ok(text.indexOf('*Agenda de hoje*') < text.indexOf('*Contas a pagar*'));
});

test('no bills in the briefing: no bills block', () => {
  const text = composeSummary({ day: [], waiting: [], prs: [], approvals: 0, briefing: { localDate: '2026-10-28', sources, items: [{ section: 'agenda', title: 'Reunião 10h', urgency: 'normal' }] } });
  assert.ok(!text.includes('Contas a pagar'));
});
