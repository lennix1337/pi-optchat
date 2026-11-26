const after = Number(process.env.HANG_REPORT_MS) || 480000;

export default async function* (source) {
  const started = new Set();
  let timer;
  for await (const e of source) {
    const { file, name, nesting, line, column } = e.data ?? {};
    if (!file || name !== file || nesting !== 0 || line !== 1 || column !== 1) continue;
    if (e.type === 'test:complete') started.delete(file);
    if (e.type !== 'test:dequeue') continue;
    started.add(file);
    timer ??= setTimeout(() => {
      if (started.size === 0) return;
      process.stderr.write(`HANG-REPORT after ${after} ms, files started and not finished:\n${[...started].sort().join('\n')}\n`);
    }, after).unref();
  }
  clearTimeout(timer);
}
