import { readFileSync, appendFileSync } from 'node:fs';

if (process.argv[1]?.endsWith('fake-revisor.mjs')) {
  const prompt = readFileSync(0, 'utf8');
  if (process.env.FAKE_REVISOR_LOG) appendFileSync(process.env.FAKE_REVISOR_LOG, prompt);
  const args = process.argv.slice(2);
  if (process.env.FAKE_REVISOR_ARGS) appendFileSync(process.env.FAKE_REVISOR_ARGS, JSON.stringify(args) + '\n');
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : '';
  const outcome = JSON.parse(process.env.FAKE_REVISOR_OUTCOMES ?? '{}')[model];
  if (outcome?.stderr) process.stderr.write(outcome.stderr);
  process.stdout.write(outcome?.stdout ?? (process.env.FAKE_REVISOR_ANSWER || JSON.stringify({ verdict: 'approve', findings: [] })));
  process.exitCode = outcome?.code ?? 0;
}

export const runDeterministicPrePass = () => [];
export const trimDiff = diff => ({ diff, skipped: [], cut: [] });
export const parseReviewAnswer = JSON.parse;
export function mergeReview(pre, model) {
  const findings = [...pre, ...(model?.findings ?? [])];
  const verdict = findings.some(f => f.severity === 'blocker') || model?.verdict === 'block' ? 'block'
    : findings.some(f => f.severity === 'major') || model?.verdict === 'changes' ? 'changes' : 'approve';
  return { verdict, findings };
}
