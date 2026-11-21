export function teamBlocks(team: readonly string[] | undefined): unknown[] {
  if (team === undefined) return [];
  const rows = team.length ? team.slice(0, 30).map(line => ({ type: 'section', text: { type: 'mrkdwn', text: line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 3000) || ' ' } })) : [{ type: 'section', text: { type: 'mrkdwn', text: 'Nenhum worker rodando.' } }];
  return [
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: 'Equipe' } },
    ...rows,
    ...(team.length > 30 ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `Mais ${team.length - 30} workers` }] }] : []),
  ];
}

export function diagramBlocks(diagram: { file?: string; source?: string } | undefined): unknown[] {
  if (diagram?.file) return [{ type: 'image', slack_file: { id: diagram.file }, alt_text: 'Conexões da equipe' }];
  if (!diagram?.source) return [];
  let source = diagram.source.replace(/`/g, "'");
  const parts: unknown[] = [];
  while (source.length) {
    let end = Math.min(2994, source.length);
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1]!)) end--;
    parts.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${source.slice(0, end)}\`\`\`` } });
    source = source.slice(end);
  }
  return [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Diagrama indisponível; fonte Mermaid:' }] }, ...parts];
}
