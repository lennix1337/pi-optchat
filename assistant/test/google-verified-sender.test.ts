import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmailVerifiedSender } from '../src/connectors/google.ts';

const FROM = 'Energia Fake <contas@energia.example.test>';
const GMAIL = 'mx.google.com;\r\n       dkim=pass header.i=@energia.example.test header.s=s1 header.b=AbCdEf12;\r\n       spf=pass (google.com: domain of contas@energia.example.test designates 192.0.2.1 as permitted sender) smtp.mailfrom=contas@energia.example.test;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=energia.example.test';

test('a real Gmail verdict with folded lines, comments and several methods is accepted', () => {
  assert.equal(gmailVerifiedSender(FROM, GMAIL), true);
  assert.equal(gmailVerifiedSender(FROM, GMAIL.replace('header.from=energia.example.test', 'header.from="energia.example.test"')), true, 'quoted value');
  assert.equal(gmailVerifiedSender(FROM, GMAIL.replace('mx.google.com', 'MX.Google.com').replace('dmarc=pass', 'DMARC=Pass')), true, 'case-insensitive');
  assert.equal(gmailVerifiedSender('"Fake <x@evil.example.test>" <contas@energia.example.test>', GMAIL), true, 'the domain is the one of the last address');
});

test('text inside comments or quotes never counts as a verdict', () => {
  const failed = 'mx.google.com; dmarc=fail (p=REJECT) header.from=energia.example.test';
  assert.equal(gmailVerifiedSender(FROM, failed), false);
  assert.equal(gmailVerifiedSender(FROM, 'mx.google.com; spf=pass (google.com: domain of "x; dmarc=pass header.from=energia.example.test"@evil.example.test designates 192.0.2.1 as permitted sender) smtp.mailfrom=evil.example.test; dmarc=fail header.from=energia.example.test'), false, 'verdict forged in an spf comment');
  assert.equal(gmailVerifiedSender(FROM, 'mx.google.com; spf=pass (a (nested; dmarc=pass header.from=energia.example.test) b) smtp.mailfrom=evil.example.test; dmarc=fail header.from=energia.example.test'), false, 'nested comment');
  assert.equal(gmailVerifiedSender(FROM, 'mx.google.com; dkim=pass header.i="@x; dmarc=pass header.from=energia.example.test"; dmarc=fail header.from=energia.example.test'), false, 'verdict inside a quoted value');
  assert.equal(gmailVerifiedSender(FROM, 'mx.google.com; dmarc=pass reason="header.from=energia.example.test" header.from=evil.example.test'), false, 'quoted text is not a property');
});

test('only a verdict from mx.google.com about exactly the From domain counts', () => {
  assert.equal(gmailVerifiedSender(FROM, GMAIL.replace('mx.google.com', 'mx.evil.example.test')), false);
  assert.equal(gmailVerifiedSender(FROM, GMAIL.replace('mx.google.com', 'x.mx.google.com')), false);
  assert.equal(gmailVerifiedSender(FROM, GMAIL.replace('header.from=energia.example.test', 'header.from=example.test')), false);
  assert.equal(gmailVerifiedSender(FROM, GMAIL.replace('header.from=energia.example.test', 'header.from=xenergia.example.test')), false);
  assert.equal(gmailVerifiedSender('no address', GMAIL), false);
  assert.equal(gmailVerifiedSender(FROM, undefined), false);
  assert.equal(gmailVerifiedSender(FROM, ['mx.google.com; dmarc=pass header.from=energia.example.test']), false, 'not a single header value');
});
