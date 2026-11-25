# Custo de API por entrega

```sh
node scripts/cost-report.mjs
node scripts/cost-report.mjs --week 2026-11-16 --json
```

O relatório usa o perfil de `OPTCHAT_PROFILE` (ou `--profile-dir`), sem o alterar. Sem `--week`, mostra hoje e seis dias anteriores; com `--week`, a data é o primeiro dos sete dias. Datas seguem o fuso local do processo (`TZ` para selecionar outro fuso). `--json` inclui dados por entrega e sete pontos com mediana e quartis da janela móvel. As estatísticas excluem entregas incompletas e mostram a cobertura dos dois períodos: a variação não demonstra economia quando as amostras mudam.

Configuração opcional no arquivo `cost-report.json` do perfil (ou `--config`):

```json
{
  "weekly": true,
  "deployRepo": "example/widget",
  "githubScope": "author:@me"
}
```

- `weekly`: acrescenta um resumo ao placar existente de segunda-feira no Slack, com sete dias completos. Não publica o relatório detalhado. Desligado por padrão.
- `deployRepo`: repositório associado ao `RESUMO` de `dentai-ship`. Sem a configuração, o deploy identificado aparece com repositório desconhecido. O veredicto do script é mantido, inclusive quando a verificação pós-deploy falhou.
- `githubScope`: `author:@me` (padrão, usando a conta ativa do `gh`) ou uma lista de qualificadores `repo:owner/repo` separados por espaços. Use os repositórios acompanhados para incluir merges de PRs de terceiros; PRs sem vínculo ficam sem estimativa, mesmo quando o GitHub confirma o merge.
- `sessionsDir`: altera o diretório padrão `sessions` do Pi (`--sessions-dir` prevalece).
- `prices`: substitui a lista de `src/cost-rates.json`. Cada faixa tem `provider` (conta ou provedor base), `modelPrefix`, `input`, `output`, `cacheRead` e `cacheWrite` em US$/milhão de tokens, e `reference`. `[]` desativa substituição por tabela. O valor gravado no ledger tem prioridade. O padrão usa os preços publicados de [GPT-5.4](https://openai.com/api/pricing/) **como referência**, não como uma tarifa específica dos modelos Codex sem preço; gravação de cache é tratada como entrada nessa referência.

O índice `usage.db` é aberto em leitura, com posições no `usage.jsonl` recuperando IDs de workers. O custo do turno principal é dividido entre as entregas ligadas ao turno na sessão do Pi. Para auto-merge, o turno que enviou a PR é usado se não houver um merge direto identificado; notificações passivas não são consideradas entrega de um turno. Uma aceitação explícita ou a combinação não ambígua de branch reportada e nome de repositório vincula o custo do worker. O papel `crew` sem ID de run representa a memória, contabilizada separadamente.

Este é um relatório de atribuição por evidência: sessões truncadas ou ausentes, PRs enviados fora do Pi e comandos cujos resultados não registraram a entrega podem produzir custos sem vínculo. Deploys não registrados pelo wrapper ou na sessão não são descobertos. O agy é ligado quando há registro de modelo e do checkout/branch; sem contagens de tokens de entrada, saída e cache, o custo total fica desconhecido mesmo se houver parcela do OptChat. Totais por conta somam chamadas feitas no período; totais por repositório incluem trabalho anterior ligado às entregas, por isso não têm o mesmo denominador. `--merges` permite reprocessar uma lista salva com `url`, `at` (epoch em ms), `title` e `branch` sem consultar o GitHub.
