import { inspectEgress } from '../policy/egress.ts';
import type { MailMessage, SourceRef } from '../connectors/google.ts';

/**
 * Explainable, rule-based mail triage. Message text is only ever matched against fixed patterns: it cannot add
 * rules, name its own urgency, or reach grants, tasks or tools, and a message that reads like instructions to an
 * assistant is marked and never escalated. Reasons and signals come from a fixed vocabulary, never from the
 * message. These heuristics miss things and flag benign mail; uncertainty says how much weight a result deserves.
 */
export type Urgency = 'urgent' | 'normal' | 'low';
export type Uncertainty = 'low' | 'medium' | 'high';
export type TriageReason = 'suspected_injection' | 'executable_attachment' | 'promotional' | 'urgent_terms' | 'trusted_sender' | 'no_signal';
export type TriageSignal = TriageReason | 'private_data' | 'promotional_label';
/** Operator-owned triage configuration. */
export type TriageRules = { trustedSenders: readonly string[] };
export type Triage = { sourceRef: SourceRef; urgency: Urgency; reason: TriageReason; uncertainty: Uncertainty; private: boolean; suspectedInjection: boolean; signals: TriageSignal[] };

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your|any)\b.{0,30}\b(instructions?|rules|prompts?|guidelines|polic(y|ies))\b/is,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\b(ai|assistant|agent|llm|chatbot|copilot)\b.{0,80}\b(must|should|shall|now|immediately)\b.{0,60}\b(forward|send|grant|approve|run|execute|delete|transfer|wire|reply|share|create)\b/is,
  /\b(run|execute)\b.{0,30}\b(command|script|powershell|bash|cmd|curl)\b/i,
  /\bforward\b.{0,20}\b(all|every|each)\b.{0,40}\b(e-?mails?|messages|inbox|contacts)\b/i,
  /\bignor[ea]\b.{0,40}\binstru[cç][oõ]es\b/i,
  /\b(assistente|agente|ia)\b.{0,80}\b(encaminhe|envie|execute|apague|aprove|transfira|conceda)\b/is,
];
const URGENT_TERMS = /\b(urgent|urgente|asap|immediately|imediatamente|today|hoje|deadline|prazo|overdue|vencid[oa]|end of day|eod|outage|fora do ar)\b/i;
const PROMOTIONAL_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']);
const PROMOTIONAL_TERMS = /\b(unsubscribe|newsletter|descadastr\w*|promo(tion|ção)?|% off|sale)\b/i;
const PRIVATE_REASONS = new Set(['payment_data', 'authentication_data', 'sensitive_identifier']);

/** The bare address of a From header, lowercased. */
export function senderAddress(from: string): string {
  const match = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from) ?? /^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(from);
  return match ? match[1].toLowerCase() : '';
}

export function triage(message: MailMessage, rules: TriageRules): Triage {
  const text = `${message.subject}\n${message.body}`;
  const signals = new Set<TriageSignal>();
  const suspectedInjection = INJECTION_PATTERNS.some(pattern => pattern.test(text));
  const trusted = rules.trustedSenders.some(sender => sender.toLowerCase() === senderAddress(message.from));
  const isPrivate = inspectEgress(Buffer.from(text), []).reasons.some(reason => PRIVATE_REASONS.has(reason));
  if (suspectedInjection) signals.add('suspected_injection');
  if (message.attachments.some(a => a.executable)) signals.add('executable_attachment');
  if (message.labels.some(label => PROMOTIONAL_LABELS.has(label))) signals.add('promotional_label');
  if (PROMOTIONAL_TERMS.test(text)) signals.add('promotional');
  if (URGENT_TERMS.test(text)) signals.add('urgent_terms');
  if (trusted) signals.add('trusted_sender');
  if (isPrivate) signals.add('private_data');
  const result = (urgency: Urgency, reason: TriageReason, uncertainty: Uncertainty): Triage =>
    ({ sourceRef: message.ref, urgency, reason, uncertainty, private: isPrivate, suspectedInjection, signals: [...signals].sort() });

  // Order matters: content cannot escalate itself past a safety signal or Gmail's own category.
  if (suspectedInjection) return result('normal', 'suspected_injection', 'high');
  if (signals.has('executable_attachment') && !trusted) return result('normal', 'executable_attachment', 'high');
  if (signals.has('promotional_label')) return result('low', 'promotional', 'low');
  if (signals.has('urgent_terms')) return result('urgent', 'urgent_terms', trusted ? 'low' : 'medium');
  if (trusted) return result('normal', 'trusted_sender', 'low');
  if (signals.has('promotional')) return result('low', 'promotional', 'medium');
  return result('normal', 'no_signal', 'medium');
}
