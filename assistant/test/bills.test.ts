import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billTiming, daysUntil, detectBill } from '../src/briefing/bills.ts';

const TODAY = '2026-10-28';
const bill = (subject: string, body: string, today = TODAY) => detectBill({ subject, body }, today);

test('due dates in numeric, ISO and Portuguese written forms', () => {
  assert.deepEqual(bill('Fatura', 'Vencimento: 30/10/2026'), { dueDate: '2026-10-30', amount: null, daysLeft: 2 });
  assert.equal(bill('Fatura', 'Vencimento 30/10/26')?.dueDate, '2026-10-30');
  assert.equal(bill('Invoice', 'Due date: 2026-11-04')?.dueDate, '2026-11-04');
  assert.equal(bill('Boleto', 'Vence em 5 de novembro de 2026')?.dueDate, '2026-11-05');
  assert.equal(bill('Boleto', 'vence dia 5 de novembro')?.dueDate, '2026-11-05');
  assert.equal(bill('Fatura', 'Pague até 12 de março de 2027.', '2027-03-01')?.dueDate, '2027-03-12');
});

test('a date without a year takes the year that lands closest to today', () => {
  assert.equal(bill('Fatura', 'Vencimento: 02/01', '2026-12-30')?.dueDate, '2027-01-02');
  assert.equal(bill('Fatura', 'Vencimento: 30/12', '2027-01-02')?.dueDate, '2026-12-30');
});

test('not a bill: no billing word, no due-date label, impossible date, or out of the window', () => {
  assert.equal(bill('Almoço', 'O prazo vence amanhã, 29/10/2026'), null);
  assert.equal(bill('Fatura de outubro', 'Seu extrato do dia 29/10/2026 está pronto'), null);
  assert.equal(bill('Fatura', 'Vencimento: 31/02/2026'), null);
  assert.equal(bill('Fatura', 'Vencimento: 01/05/2026'), null, 'long past');
  assert.equal(bill('Fatura', 'Vencimento: 30/12/2026'), null, 'too far ahead');
  assert.equal(bill('Fatura', 'Vencimento: 05/10/2026')?.daysLeft, -23, 'overdue but recent');
  assert.equal(detectBill({ subject: 'Fatura', body: 'Vencimento: 30/10/2026' }, 'not-a-date'), null);
});

test('generic words and loose labels are not enough', () => {
  assert.equal(bill('Conta criada', 'Seu plano vence em 30/10/2026'), null, 'bare "conta"');
  assert.equal(bill('Bill sent a note', 'Due 30/10/2026'), null, 'bare "bill"');
  assert.equal(bill('Payment received', 'Delivery due 2026-10-30'), null, 'bare "payment"');
  assert.equal(bill('Fatura', 'O prazo vence 30/10/2026'), null, '"vence" without em/dia/:');
  assert.equal(bill('Fatura', 'due to maintenance on 30/10/2026'), null, 'a "due" that is not a label');
  assert.equal(bill('Conta de luz', 'Vence em 30/10/2026')?.dueDate, '2026-10-30');
  assert.equal(bill('Sua conta a pagar', 'Vence: 30/10/2026')?.dueDate, '2026-10-30');
  assert.equal(bill('Your bill is due', 'Due on 2026-10-31')?.dueDate, '2026-10-31');
});

test('the amount: the total when labelled, otherwise the first one', () => {
  assert.equal(bill('Fatura', 'Desconto R$ 5,00. Valor total: R$ 1.234,56. Vencimento: 30/10/2026')?.amount, 'R$ 1.234,56');
  assert.equal(bill('Fatura', 'Vencimento: 30/10/2026. Pague R$ 80,00 ou R$ 90,00')?.amount, 'R$ 80,00');
  assert.equal(bill('Invoice', 'Amount: $ 42.50, due date 2026-10-31')?.amount, '$ 42.50');
  assert.equal(bill('Fatura', 'Vencimento: 30/10/2026')?.amount, null);
});

test('timing: overdue and up to 3 days are urgent, later is not', () => {
  assert.deepEqual([-1, 0, 3, 4].map(d => billTiming(d).reason), ['bill_overdue', 'bill_due_soon', 'bill_due_soon', 'bill_upcoming']);
  assert.deepEqual([-1, 3, 4].map(d => billTiming(d).urgency), ['urgent', 'urgent', 'normal']);
  assert.deepEqual([-7, -8, -30].map(d => [billTiming(d).reason, billTiming(d).urgency]), [['bill_overdue', 'urgent'], ['bill_overdue', 'normal'], ['bill_overdue', 'normal']]);
  assert.equal(daysUntil('2026-10-28', '2026-11-02'), 5);
  assert.equal(daysUntil('2026-10-28', '2026-13-02'), null);
});
