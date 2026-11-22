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
