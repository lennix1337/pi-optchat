// JSONL evidence for scripts/bench-verify.ps1, deliberately outside the checkout.
import { appendFileSync } from 'node:fs';
export default async function* report(events) {
  for await (const event of events) {
    if (['test:summary', 'test:fail'].includes(event.type)) {
      const line = JSON.stringify(event, (_key, value) => value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value) + '\n';
      appendFileSync(process.env.OPTCHAT_SUITE_EVENTS, line);
      yield line;
    }
  }
}
