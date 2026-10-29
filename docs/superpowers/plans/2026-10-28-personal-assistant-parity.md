# Assistente pessoal integrado — plano de implementação

**Data:** 2026-10-28.
**Status:** plano; nenhuma capacidade deste documento está implementada ou validada por ele.
**Pedido:** implementar as capacidades ausentes em relação ao CopilotKit/OpenDuet; usar agentes 6.1 tera na implementação.
**Goal:** integrar execução, memória e agentes já existentes a um assistente pessoal durável, governado, acessível pelo terminal, web/celular e canais externos.
**Architecture:** manter Pi/OptChat como cliente e memória canônica desta conversa; acrescentar um serviço local opcional, contratos versionados e uma interface web. Reutilizar as fronteiras de autorização, recuperação, subagentes e ferramentas existentes; não duplicar suas fontes de verdade.
**Tech Stack proposto:** TypeScript/Node 24 para o serviço, SQLite local, HTTP/stream de eventos autenticado e React/Vite para a interface. Estes componentes ficam num pacote separado dentro deste repositório, sem elevar o requisito de Node da extensão atual. Confirmar Node/SQLite e dependências antes do primeiro código desse pacote; não instalar runtimes globalmente.

## 1. Referência, evidência e limites

Referência congelada: `CopilotKit/OpenDuet@60fd4c71d9d82e13739dce00827278154d13c947`.
- README: https://github.com/CopilotKit/OpenDuet/blob/60fd4c71d9d82e13739dce00827278154d13c947/README.md
- Rotinas: `openbot/docs/routines.md` nessa revisão.
- Aprendizado: `openbot/docs/automatic-learning.md` nessa revisão.
- Comparação por documentação/código; não é evidência de execução do produto deles.

Base local inspecionada: `pi-optchat@057e56f41`, especialmente `src/heartbeat.ts`, `src/catchup-integration.ts`, `src/operational-state.ts`, `.pi/checks.json`, README e contratos de ferramentas. Navegação: recibo Ripwire `d885bc55-fcb6-4255-9bbd-49e21ae7ca22` (cobertura baixa; apenas ponto de partida).

Não considerar uma capacidade concluída porque existe um módulo, endpoint 200, mock, CI verde ou menção no README. Cada entrega exige ação → execução → persistência/estado → resultado visível → decisão/ação final, conforme aplicável.

### Limites de execução

- Este pedido produz o plano. Não é ativação de serviço, agendamento, conta, conector, notificação externa ou ambiente de produção.
- Na implementação, começar com credenciais descartáveis, rede bloqueada e provedor roteirizado; conectar contas reais somente com autorização específica.
- Não recarregar esta sessão, modificar logins, instalar serviço/tarefa de inicialização, liberar porta externa, criar assinatura/custo, fazer deploy/release ou escrever em produção por decorrência deste documento.
- Mensagens, arquivos, e-mails e respostas de conectores são dados não confiáveis, não autorização.
- O serviço não adquire os privilégios do operador por conhecer o histórico. Um wake, um canal remoto ou um worker não se tornam entrada humana local.
- Nenhuma alteração automática em instruções, skills, ABOUT-ME, memória canônica ou permissões como efeito de aprendizado.
- Preservar alterações existentes em todos os repositórios e ambos os perfis. Planejar migrações aditivas e reversíveis.

## 2. Matriz completa de cobertura

| ID | Capacidade/resultado | Aproveitar | Entrega | Prova mínima de aceitação |
|---|---|---|---|---|
| C01 | Memória contínua, consulta e correção | histórico, zoom/date, sincronização opcional | T09 | origem exata, correção rastreável, isolamento entre perfis |
| C02 | Skills, modelos e personalização dos agentes | Pi, multi-account, subagents, dotfiles | T01/T13 | sessão nova encontra skill/config, identidade e permissões corretas |
| C03 | Trabalho fora do terminal | heartbeat/goals/subagents | T03 | fechar terminal, executar tarefa permitida, reabrir e observar resultado |
| C04 | Rotinas criar/listar/pausar/retomar/histórico | wake/dream como consumidores opcionais | T04 | execução persistente, fuso/DST e falhas, sem duplicação indevida |
| C05 | Computador próprio por agente | worktrees apenas para código | T06 | navegador/workspace segregados; acesso ao host negado |
| C06 | Aprovar/recusar/permitir uma vez/regra limitada | authorization/autonomy/operations | T02/T10 | ação exibida corresponde ao despacho; replay e alteração recusados |
| C07 | Segredos sem passar pelo modelo | auth especializada existente | T05 | valor ausente de prompt, ferramentas, logs, screenshots e eventos |
| C08 | Revisão de saída para terceiros | classificação de efeitos | T02/T07 | destino+conteúdo revistos, aprovação válida, DLP e auditoria |
| C09 | Gmail + Calendar por conta | navegador não equivale a conector | T07 | ler conta consentida, revogar; envio/evento apenas após revisão específica |
| C10 | Drive/Notion e MCP governado | catálogo MCP/ferramentas | T08 | leitura permitida funciona, ferramenta não concedida é negada |
| C11 | Triagem com razão e prioridades | radar/seleção contextual | T07 | avaliações rotuladas, incerteza/fonte visíveis, nenhum envio automático |
| C12 | Briefing diário e sob demanda | catch-up/briefing | T07/T10 | uma entrega diária por perfil/fuso, links e indisponibilidades explícitos |
| C13 | Caixa única de tarefas/pendências/sugestões | catch-up, operações, agentes | T01/T10 | decisão/resposta muda o estado correto; deep link ao trabalho |
| C14 | Onboarding/setup verificável | configuração existente | T11 | pronto/não verificado/precisa configurar refletem observações reais |
| C15 | Conhecer usuário e aceitar correções | ABOUT-ME + memória | T09/T11 | fonte indicada, usuário corrige; sem inferir identidade como fato |
| C16 | Galeria Make: docs, slides, páginas, dashboards/designs | capacidades de geração/skills | T12 | produzir, abrir, revisar, baixar e reencontrar artefato versionado |
| C17 | Canais por assunto, cores, arquivo | perfis/conversa atual | T10 | contexto do canal correto sem duplicar nem fragmentar a fonte canônica |
| C18 | Respostas rápidas | comandos e UI | T10 | clique vale só para a decisão atual; opções antigas expiram |
| C19 | Web/celular, tema claro/escuro e acessibilidade | novo cliente | T10 | fluxo completo teclado/toque, 360px, tema do sistema, sem overflow |
| C20 | Voz para mensagem | transcrição local disponível | T12 | gravar → transcrever → revisar → enviar; falha não envia texto parcial |
| C21 | Slack e Teams | sem equivalência integrada verificada | T14 | remetente/tenant validados, redelivery não duplica ação, revogação |
| C22 | Aprendizado revisável e mensurável | dream/skills/memória | T09 | proposta → aprovação → aplicação explícita → avaliação → rollback |
| C23 | Tomar controle em login/2FA | agent-browser + computador isolado | T05/T06/T10 | humano assume e devolve controle sem expor segredo ao agente |
| C24 | Auditoria/saúde/backup/notificações | operations/checks/catch-up | T03/T13 | restaurar estado, mostrar bloqueio real e entregar aviso uma vez logicamente |

## 3. Arquitetura e contratos antes dos escritores

### Distribuição proposta de arquivos

**Código existente a adaptar, somente pelo integrador:**
- `src/index.ts`: registro fino do cliente opcional, sem lógica de serviço.
- `src/assistant-client.ts` (novo): conexão autenticada, reconexão, projeções e comandos do Pi.
- `src/authorization.ts`, `src/authorization-hooks.ts`, `src/autonomy.ts`: adaptar fronteiras existentes, não criar uma segunda política concorrente.
- `src/operations.ts`, `src/operational-state.ts`: leitura/projeção de evidências e reconciliação, sem importar afirmações como verificações.
- `src/catchup-integration.ts`, `src/heartbeat.ts`: consumidores dos contratos; não substituir o histórico nem criar outro loop de wakes.
- `README.md`, `.pi/checks.json`: descoberta e gates do pacote.

**Pacote separado proposto:**
- `assistant/package.json`, `assistant/tsconfig.json`, `assistant/.pi/checks.json`.
- `assistant/src/contracts/{events,tasks,approvals,connectors,artifacts}.ts`: contratos públicos versionados.
- `assistant/src/store/{db,migrations,events}.ts`: armazenamento transacional e migrações.
- `assistant/src/runtime/{worker,claims,recovery,outbox}.ts`: execução, posse, reconciliação e entregas.
- `assistant/src/policy/{gateway,grants,egress}.ts`: decisão mecânica e admissão por adaptadores da política existente.
- `assistant/src/routines/{schedule,service}.ts`: calendário e estado das rotinas.
- `assistant/src/secrets/{vault,broker}.ts`: referência opaca, criptografia e injeção restrita.
- `assistant/src/computer/{protocol,manager}.ts`: contrato de computador isolado e ciclo de vida.
- `assistant/src/connectors/{google,mcp,notion,drive}.ts`: adapters com escopo explícito.
- `assistant/src/briefing/{triage,compose}.ts`: seleção explicável e briefing com fontes.
- `assistant/src/memory/{projection,proposals}.ts`: leitura da fonte canônica e propostas de aprendizado.
- `assistant/src/artifacts/{registry,preview}.ts`: metadados, versões e visualização segura.
- `assistant/src/channels/{web,slack,teams}.ts`: proveniência e despacho de canais.
- `assistant/src/http/{server,auth}.ts`: API local autenticada e eventos retomáveis.
- `assistant/web/src/{app,inbox,approvals,routines,connections,setup,artifacts,channels,voice}/`: telas por domínio.
- `assistant/test/`: testes de domínio, fronteira, runtime e jornadas.
- `skills/personal-assistant/SKILL.md`: descoberta e comandos, implementada apenas quando houver algo executável.

**Configuração/distribuição:** `C:/projetos/dotfiles/payload/pi/`: instruções curtas, exemplos, checks e pins; nunca credenciais, áudio, filas, bancos, logs ou artefatos pessoais.
**Runtime proposto:** `~/.optchat/profiles/<profile>/assistant/`; segredos num armazenamento protegido separado. Permissões de arquivo, namespace e migração por perfil são requisitos, não defaults presumidos.

### Contratos mínimos congelados em T01

- Identidade: `profileId`, `actorId`, `sourceKind`, `sourceEventId`, `channelId`, `taskId`, `runId`; IDs distintos em fixtures.
- Evento: versão, ID, origem, instante observado, sequência local, correlação e referência de evidência. Conteúdo bruto privado separado da projeção/UI.
- Tarefa: `suggested | queued | working | needs_input | ready_for_review | succeeded | failed | cancelled | resolved`.
- Verificação do resultado é campo separado: `verified | not_verified | blocked`. `resolved` não prova sucesso.
- Tentativa: `planned | claimed | running | effect_uncertain | reconciled | finished`; nunca reenfileirar efeito incerto sem reconciliação/idempotência.
- Pedido de aprovação: identidade, efeito, destino, hash canônico dos argumentos/conteúdo, prazo, versão de política, posse e escopo. Consumo transacional de concessão única no despacho.
- Regra durável é mudança de política com escopo e revisão explícitos; botão de execução não pode criar uma regra silenciosa.
- Ferramenta/conector: conta, servidor, esquema, capacidades concedidas, classificação de efeitos e referência de segredo; desconhecido é conservador, não leitura presumida.
- Artefato: dono, tipo, versão, hash, produtor, localização, proveniência e resultado da revisão; HTML é conteúdo não confiável.
- Estado visível é projeção dos eventos, não duplicação mutável em Pi/web/Slack.

### Semântica de execução

Transações locais e outbox dão entrega pelo menos uma vez com deduplicação. **Não prometer exactly-once para efeitos externos.** Se uma API não aceitar idempotência nem permitir consulta inequívoca, timeout após despacho vira `effect_uncertain`, fica visível e exige reconciliação antes de tentar novamente.

Um único dono/lease por perfil e fencing token por tentativa evitam Pi+serviço executando a mesma ação. Cancelamento revoga admissão de novos efeitos; não afirma desfazer o que já saiu. Atualização de política, logout e troca de conta invalidam aprovações incompatíveis.

## 4. Plano de execução e delegação

Modelo solicitado e confirmado na descoberta: `openai-codex-account-2/gpt-6.1-terra` (default do worker: `low`). Usar esse modelo explicitamente em escritores/revisores; manter thinking configurado salvo necessidade específica justificada. O nome informal do pedido foi “6.1 tera”.

- Parent permanece supervisor: requisitos, limites, contratos compartilhados, integração, revisão final e aceitação.
- Sem fallback de modelo/executor após quota, falha de lançamento ou infraestrutura. Registrar e bloquear a lane; não repetir efeitos incertos.
- Até **3 escritores independentes** por onda, cada qual em `C:/projetos/pi-optchat/worktrees/<lane>`; ajustar para menos se disco/quota limitarem. Não criar todas as worktrees antecipadamente.
- T01 congela contratos antes de fanout. Um dono por arquivo/contrato; alterações compartilhadas voltam ao integrador.
- Cada briefing: “You are a subagent. Don't write memory pages.” + objetivo, cwd/ref, arquivos exclusivos, autoridade, fontes, critérios, comandos de validação, saída esperada e condição de parada.
- Cada PR entrega um comportamento utilizável. Não agrupar todo o programa numa PR gigante.
- Revisão por agente 6.1-terra em contexto novo quando integração ou segurança justificar; revisão final/decisão ficam no parent.
- Workers não publicam releases, fazem deploy, conectam contas nem ativam serviços. PRs próprios seguem a política vigente; auto-merge não pode integrar antes da validação acabar. Se o GitHub permitir merge imediato, aguardar gates antes de solicitá-lo.

### Ordem das ondas

| Onda | Pacotes | Resultado ao terminar |
|---|---|---|
| A | T01 → T02; T03 após contratos | tarefa local visível, governada e recuperável |
| B | T04, T05, T06 | rotinas e execução isolada, ainda com fontes descartáveis |
| C | T07, T08, T09 | conectores e inteligência revisável, inicialmente read-only |
| D | T10, T11, T12 | produto web/celular completo, artefatos e voz |
| E | T13, T14 | instalação/recuperação e canais externos, ativação controlada |

Dependências específicas abaixo prevalecem sobre a tabela. T10 começa só com o fluxo local mínimo, depois integra telas por domínio conforme os contratos estabilizam. Não lançar writers de UI e API sobre o mesmo contrato ainda móvel.

## 5. Pacotes de trabalho

Para cada pacote: primeiro fixture/jornada que demonstra a lacuna; confirmar vermelho pelo motivo esperado; implementar mínimo; provar verde e controles negativos; revisar diff; registrar evidência. Testes de guardas devem falhar por mutação ao remover a guarda.

### T01 — Contratos e caixa única no terminal
**Depende:** nenhum. **Dono:** contratos/projeção.
**Arquivos:** `assistant/src/contracts/*.ts`, `assistant/src/store/*.ts`, `assistant/src/http/{server,auth}.ts`, `assistant/test/{contracts,tasks,ownership}.test.ts`; integrador adapta `src/assistant-client.ts` e registro em `src/index.ts`.
- [ ] Fixar os contratos da seção 3 com parsers de fronteira, migrações versionadas e tabela de autoridade por origem.
- [ ] Criar fixture em que IDs de sessão, perfil, canal e tentativa diferem; rejeitar acesso entre perfis e eventos com sequência/versão inválidas.
- [ ] Projetar tarefas, aprovações existentes, agentes, falhas, evidências e sugestões com referências às fontes, sem transformar relatos em resultados verificados.
- [ ] Entregar listagem/detalhe/decisão via cliente Pi; ler a caixa não resolve tarefa nem consome aprovação.
**Aceite:** criar tarefa descartável, obter input, responder, terminar e abrir evidência original; reload/restart não perde ou duplica a tarefa. Resposta antiga ou de outro perfil é recusada.

### T02 — Gateway comum, aprovações e revisão de saída
**Depende:** T01. **Dono:** segurança/política.
**Arquivos:** `assistant/src/policy/*.ts`, `assistant/test/{gateway,approval-replay,egress}.test.ts`; integrador adapta `src/authorization*.ts`, `src/autonomy.ts`, `src/operations.ts`.
- [ ] Enumerar todos os caminhos de efeito: conector, browser, shell, worker, serviço, API/UI e canais; nenhum adapter pode despachar fora do gateway.
- [ ] Preservar o contrato vigente de aprovar apenas efeitos críticos; leituras e trabalhos locais permitidos não viram burocracia. Ações externas herdam os limites específicos do operador.
- [ ] Implementar aprovação vinculada a destino+conteúdo+conta+prazo, recusa, expiração e regra persistente explicitamente delimitada.
- [ ] Separar aprovar, despachar, resposta externa e resultado observado; timeout não é sucesso.
- [ ] Revisar saída para segredos conhecidos, dados de pagamento e padrões sensíveis; não alegar detecção perfeita de PII semântica. Incerto pede revisão; mostrar diagnóstico seguro e minimizado.
**Aceite:** aprovar payload A e tentar B falha; dois consumidores não usam a mesma aprovação; reload não renova concessão; e-mail injetado não autoriza nada; conteúdo sensível não sai sem o controle previsto.

### T03 — Worker durável e outbox de notificações
**Depende:** T01/T02. **Dono:** runtime.
**Arquivos:** `assistant/src/runtime/*.ts`, `assistant/test/{restart,recovery,fencing,outbox}.test.ts`.
- [ ] Acrescentar worker desacoplado da TUI, posse exclusiva e parada limpa; preservar o executor Pi/subagents em vez de criar agentes via CLI improvisada.
- [ ] Persistir intenção antes do despacho, resposta/evidência após; expor `effect_uncertain` e reconciliador por adapter.
- [ ] Recuperar jobs internos idempotentes e enfileirar avisos com IDs estáveis e confirmação por canal; falha de entrega continua visível.
- [ ] Aplicar cancelamento, backpressure e limites de quota/concorrência; agente parado não pode criar filho ou efeito novo.
**Aceite:** matar worker antes/depois de cada fronteira, reabrir e observar estado correto; tarefa local conclui com TUI fechada; efeito externo ambíguo não se repete. Serviços reais/inicialização automática ficam para T13.

### T04 — Gerenciador de rotinas
**Depende:** T03. **Dono:** scheduler.
**Arquivos:** `assistant/src/routines/*.ts`, `assistant/test/{routines,timezone,missed-runs}.test.ts`.
- [ ] Criar/listar/editar/pausar/retomar/excluir rotina e consultar histórico, vinculando perfil, capacidades e autorização.
- [ ] Definir política explícita de horário perdido: execução única consolidada por padrão, não replay de todos os ticks; DST/fuso e relógio divergente são testados.
- [ ] Evitar sobreposição por rotina, limitar fila, mostrar próximo horário, falhas consecutivas e motivo de suspensão.
- [ ] Adaptar wakes/dream existentes sem ativá-los, duplicá-los ou transferir suas permissões automaticamente.
**Aceite:** relógio controlado cobre restart, DST e dois workers; depois ensaio local real com provedor roteirizado mostra uma entrega e pausa efetiva. Ativar agenda pessoal exige consentimento de ativação.

### T05 — Cofre e entrada privada de segredos
**Depende:** T02. **Dono:** secrets.
**Arquivos:** `assistant/src/secrets/*.ts`, `assistant/test/{vault,secret-boundary,secret-injection}.test.ts`.
- [ ] Usar criptografia autenticada e chave protegida por mecanismo do SO; chave nunca ao lado do banco em texto simples. Evitar criptografia própria.
- [ ] API aceita segredo e retorna somente referência opaca, revogável e limitada a perfil+origem+ação; proibir endpoint de recuperar valor.
- [ ] Criar formulário privado fora do contexto do modelo; excluir do transcript, snapshots, tracing, erros, clipboard e screenshots.
- [ ] Injetar segredo apenas no destino consentido; bloquear leitura subsequente pelo browser/DOM/shell/artefato. Rotacionar/revogar e limpar referências efêmeras.
**Aceite:** canário secreto conhecido não aparece em nenhuma saída/modelo/arquivo de auditoria nem no acesso de outro agente; origem alterada bloqueia injeção. Não prometer “nunca vê” se qualquer caminho do browser permitir extração: nesse caso a entrega permanece bloqueada.

### T06 — Computador isolado e takeover humano
**Depende:** T02/T05. **Dono:** computer.
**Arquivos:** `assistant/src/computer/*.ts`, `assistant/test/{computer-boundary,computer-lifecycle,takeover}.test.ts`.
- [ ] Confirmar backend disponível no host e seus limites antes de instalar/baixar/ativar algo. Selecionar isolamento existente adequado; se nenhum existir, preparar adapter e registrar bloqueio de provisionamento, não simular sandbox.
- [ ] Computador por agente/perfil: workspace e browser próprios, rede controlada, sem mounts de home/SSH/auth do host, sem Docker socket e sem serviços administrativos expostos.
- [ ] Browser usa `agent-browser`; preservar regra local, não usar Playwright/CDP MCP como fallback.
- [ ] Executar shell/browser pelo gateway; bloquear saídas/redes fora da concessão e navegação a origem interna/metadata. Descobertas de isolamento insuficiente são bloqueadores.
- [ ] Humano assume login/2FA, agente pausa leitura/captura, humano devolve controle; lifecycle inclui pausa, expiração e limpeza apenas de recursos próprios.
**Aceite:** agente A não lê arquivo/token/browser de B nem host; pedidos de acesso interno são negados; takeover e retorno funcionam sem vazamento. Container isolado de filesystem, sozinho, não prova isolamento completo.

### T07 — Google, triagem e briefing
**Depende:** T02/T03/T05; browser auxiliar somente após T06. **Dono:** Google/briefing.
**Arquivos:** `assistant/src/connectors/google.ts`, `assistant/src/briefing/*.ts`, `assistant/test/{google-oauth,google-boundaries,triage,briefing}.test.ts`.
- [ ] Implementar OAuth com state/PKCE/redirect permitido, identidade de conta verificada, escopos mínimos e revogação. Conectar contas pessoais e DentAI separadamente; não inferir qual usar.
- [ ] Primeira entrega lê e-mails e calendário; paginação, fuso, convites recorrentes, anexos não executáveis e limites de retenção explícitos.
- [ ] Triagem produz fonte, razão, urgência e incerteza; e-mail não pode modificar instruções, grants ou disparar tarefa sem política.
- [ ] Briefing junta caixa de tarefas, agenda, mensagens, mudanças e fontes indisponíveis. Deduplicar por perfil+data local mesmo com múltiplos clientes; sob demanda é identificado separadamente.
- [ ] Segunda entrega: preparar rascunho e prévia de mensagem/evento; envio ou mutação só com concessão específica para destino/conteúdo/conta. Primeira validação real usa destino controlado autorizado.
- [ ] Avaliação rotulada inclui distrações, mensagens urgentes, dados privados e prompt injection; relatar precisão/recall e falsos negativos, sem inventar meta ou extrapolar fixture para a caixa real.
**Aceite:** OAuth descartável → leitura → triagem → briefing → Start → tarefa rastreada. Revogar remove acesso; falha parcial aparece no briefing. Conta real e envio ficam `blocked` até consentimento.

### T08 — Drive, Notion e catálogo MCP governado
**Depende:** T02/T05. **Dono:** connectors.
**Arquivos:** `assistant/src/connectors/{mcp,drive,notion}.ts`, `assistant/test/{connector-grants,mcp-discovery,connector-revocation}.test.ts`.
- [ ] Descobrir ferramentas, esquemas e efeitos com IDs estáveis e paginação; catálogo não é permissão.
- [ ] Concessões por perfil/agente/conta/servidor/ferramenta; alterações de esquema ou efeito relevante exigem revalidação.
- [ ] Drive/Notion começam em leitura de escopo consentido; escrita é passo separado pelo gateway, com prévia/diff.
- [ ] Reutilizar servidores existentes quando o contrato satisfizer os controles; sem dependência obrigatória de Composio ou CopilotKit Intelligence.
**Aceite:** leitura concedida funciona; chamada direta não concedida, conector substituído e grant revogado são negados antes do despacho; paginação não perde itens nem expõe segredos.

### T09 — Memória visível, preferências e aprendizado
**Depende:** T01/T02. **Dono:** memory.
**Arquivos:** `assistant/src/memory/*.ts`, `assistant/test/{memory-provenance,memory-correction,learning-lifecycle}.test.ts`.
- [ ] Expor leitura/correção com original, data, autoria e distinção entre fato, resumo e hipótese; isolamento por perfil e fonte.
- [ ] Manter chat/zoom como autoridade da conversa e ABOUT-ME para fatos duráveis segundo as regras atuais; não instalar outro motor de memória concorrente.
- [ ] Criar propostas versionadas de aprendizado a partir de evidência, com mudança concreta, justificativa, teste, risco, aprovação e rollback.
- [ ] Aplicar somente após revisão humana/política explícita apropriada; nenhuma mensagem externa pode aprovar atualização de instruções ou grants.
- [ ] Medir melhoria em conjunto retido antes/depois; se não melhora, rejeitar proposta e preservar a evidência.
**Aceite:** uma inferência errada é corrigida com origem preservada; proposta aprovada pode ser aplicada e revertida; proposta rejeitada/injetada não muda nada.

### T10 — Painel web/celular, canais e respostas rápidas
**Depende:** fluxo mínimo T01–T03; integrar demais domínios após contratos estáveis. **Dono:** web UX.
**Arquivos:** `assistant/web/src/{app,inbox,approvals,routines,connections,channels}/`, `assistant/src/channels/web.ts`, `assistant/test/{web-auth,ui-routing,ui-reconnect}.test.ts`.
- [ ] Ler skills de design/impeccable e agent-browser antes de implementar a interface; preservar estilo legível em português, não copiar branding de terceiros.
- [ ] Painel com Precisa de você, Trabalhando, Pronto para revisão, Falhou e Resolvido; sugestões Start/Hide, próximo passo e links para evidências.
- [ ] Aprovar/recusar, responder e cancelar atualizam a tarefa correta sem fabricar sucesso; mensagens digitadas durante ação entram em fila ordenada e preservam autoria.
- [ ] Canais com assunto, cor, ícone e arquivo são views/contextos de trabalho; não inventar conversas canônicas paralelas. Mostrar origem e referência ao mesmo evento.
- [ ] Respostas rápidas expiram com a decisão; cartões velhos não autorizam efeitos novos. Reconexão retoma eventos pelo cursor, sem duplicar entrega.
- [ ] Autenticação, proteção CSRF/origem, tokens fora de URLs/logs, CSP e preview isolado. Serviço fica loopback por padrão; celular fora do host depende de acesso privado explicitamente configurado.
- [ ] Claro/escuro/sistema, teclado/foco, leitores de tela, toque e layout 360/768/1280px; sem vazamento de dados sensíveis em notificações na tela bloqueada.
**Aceite:** agent-browser percorre criar tarefa → input → revisão exata → decisão → resultado → resolver; eventos fora de ordem e outro perfil não alteram cartão errado. Validação de celular real é separada da emulação de viewport.

### T11 — Onboarding e setup honesto
**Depende:** T05/T07/T10. **Dono:** setup.
**Arquivos:** `assistant/web/src/setup/`, `assistant/src/setup.ts`, `assistant/test/{setup,onboarding,account-identity}.test.ts`.
- [ ] Checklist de runtime, modelo, armazenamento, isolamento, Google/conectores e notificações com Pronto/Não verificado/Precisa configurar e ação concreta de correção.
- [ ] Não chamar modelo pago no healthcheck. Credencial presente não comprova serviço funcionando; teste de inferência fica opt-in e com custo declarado.
- [ ] “Agora não” permite modo local limitado e rotula capacidades indisponíveis, sem prometer ler fonte desconectada.
- [ ] Apresentação inicial identifica o que se sabe e de onde; sugestões editáveis, “Está certo”/“Corrigir” e correção com proveniência.
**Aceite:** desconectar fonte ou fornecer URL/credencial inválida nunca produz estado Pronto; onboarding sem Google continua útil sem inventar e-mails/agenda.

### T12 — Make, previews e voz
**Depende:** T05/T10; geração isolada após T06. **Dono:** artifacts/voice.
**Arquivos:** `assistant/src/artifacts/*.ts`, `assistant/web/src/{artifacts,voice}/`, `assistant/test/{artifact-flow,preview-isolation,voice-flow}.test.ts`.
- [ ] Registrar arquivos produzidos por skills existentes: documento, slides, página, dashboard, design e design system. Não recriar os geradores; incluir renderer/exportador apenas quando necessário para o tipo suportado.
- [ ] Cards no chat, thumbnails seguras, filtro por tipo, versões, proveniência, revisão, abrir/baixar; impedir path traversal, conteúdo ativo com acesso ao host e URLs de preview públicas por acidente.
- [ ] Produzir um exemplar verificável de cada tipo, incluindo fontes/assets/licenças; apresentação/download testados no cliente, não apenas arquivo criado.
- [ ] Capturar áudio por consentimento, preferir transcrição local existente, apresentar texto para revisão e só então enviar como mensagem humana. Nunca interpretar voz sintetizada ou áudio externo como consentimento mecânico automaticamente.
- [ ] Cancelamento, ruído, idioma português, falta de microfone/provider e retenção/remoção do áudio ficam explícitos.
**Aceite:** gerar → abrir → editar/revisar → exportar → reencontrar após restart; áudio → texto revisável → envio só após confirmação. Sem provedor de voz disponível: bloqueado, não mock marcado como concluído.

### T13 — Empacotamento, operação, notificações e recuperação
**Depende:** T03/T04/T10; fechar antes de ativação pessoal ampla. **Dono:** integration/ops.
**Arquivos:** `assistant/scripts/{start,stop,health,backup,restore}.mjs`, `assistant/test/{install,backup-restore,shutdown,notifications}.test.ts`, `skills/personal-assistant/SKILL.md`, README; integrador atualiza dotfiles e pins.
- [ ] Comandos locais idempotentes e diagnóstico útil, sem sobrescrever dependências de ferramenta em uso. Detectar porta/processo existente antes de iniciar.
- [ ] Instalação de início automático no Windows é opt-in explícito, reversível; informar consumo, retenção e como parar. Sem daemon secreto durante implementação.
- [ ] Backup criptografado, migração/restore em diretório descartável e política de chave; restaurar dados sem repetir efeitos já executados.
- [ ] Notificações locais/web com consentimento, horário silencioso, dedup, minimização e estado de entrega; não confundir aceitação pelo transporte com leitura pelo humano.
- [ ] Descoberta em sessão nova: skill, instruções curtas, comandos e limites. Sincronizar dotfiles para ambos os perfis e OpenCode quando aplicável, preservando autenticação.
- [ ] Atualização segura: parar admissão, drenar/checkpoint, migrar, reiniciar, healthcheck e rollback compatível; shells/subagents existentes conservam suas fronteiras.
**Aceite:** instalação descartável → tarefa → restart → notificação → backup → restore → consulta e nenhuma repetição externa; sessão nova encontra e executa o fluxo. Ativação no host requer autorização própria.

### T14 — Slack e Microsoft Teams
**Depende:** T02/T03/T05/T10/T13. **Dono:** channels.
**Arquivos:** `assistant/src/channels/{slack,teams}.ts`, `assistant/test/{slack-boundary,teams-boundary,channel-approval}.test.ts`.
- [ ] Validar assinaturas/tokens, tenant/workspace, remetente autorizado, timestamps e redelivery; separar canais, usuários, perfis e threads.
- [ ] Entregar pendências/briefing e receber respostas com IDs originais e referência à decisão; remetente remoto não ganha poder de administrador local.
- [ ] Decisões críticas abrem revisão autenticada de ação exata; bot, webhook, forward e texto citado não aprovam ações. Expiração/revogação valem em todos os canais.
- [ ] Mensagens externas saem pelo gateway e DLP; anexos são não confiáveis. Implementar retries só de transporte/idempotentes, sem reenviar efeito ambíguo.
**Aceite:** evento assinado → tarefa → decisão permitida → efeito controlado → aviso; replay forjado, outro tenant e identidade revogada não atuam. Validação real necessita apps/credenciais/espaço de teste autorizados; fixtures não provam Slack/Teams ao vivo.

## 6. Validação executável e evidência

Antes de criar scripts/rodar gates novos, inspecionar os recipes do checkout. Checks no mesmo repositório são sequenciais.

Gates existentes relevantes em `C:/projetos/pi-optchat`:
- `project_checks({root, name: "typecheck"})`
- `effect-approvals`, `effect-approval-mutations`, `effect-approval-runtime`, `effect-approval-risk-runtime`
- `operation-safety`, `catchup`, `heartbeat-selection`, `shell-lifecycle`
- `self-reload` e `self-reload-installed` quando fronteiras de lifecycle forem alteradas; nenhum reload desta sessão.
- `unit` como gate de integração após os focados necessários; logs longos em background com aviso de término.
- Ripwire `edit_check` para símbolos alterados, `quality` e `test_gate`; exit 4 do test_gate identifica testes, não aprovação nem falha de comportamento.

Para o pacote novo, primeira PR adiciona scripts e recipes reais antes de sua execução repetida:
- `contracts`, `policy`, `runtime`, `routines`, `secrets`, `computer`, `connectors`, `briefing`, `memory`, `web`, `artifacts`, `channels`, `ops`, `unit`, `typecheck`.
- `assistant/test/journeys/` cobre os aceites acima; rede negada por padrão, dados sintéticos que não coincidam entre identidades, relógio injetável e falhas nas operações reais de I/O.
- UI é dirigida com `agent-browser`; screenshots e recibos ficam em `C:/projetos/local-validation/runs/personal-assistant/`, não no Git.

Ledger por entrega nesse diretório:
`requirements.md` (C01–C24 → tarefa → critério), `progress.md` (estado/next action/jobs), `evidence.json` (ref/digest/ambiente/teste/resultado), logs e capturas.

Estados por critério: **verified / not_verified / blocked**. Documentar separadamente implementação, ensaio descartável, ativação real e resultado observado. Atualizar ledger antes de interrupção. Reaproveitar evidência válida em vez de repetir chamadas/efeitos.

## 7. Gates de ativação e rollback

### Gate A — pronto para desenvolvimento
Contratos aprovados pelo integrador, limites herdados, modelo exato disponível, checkout/worktrees/disco verificados, nenhuma dependência de acesso real para testes offline.

### Gate B — piloto local descartável
T01–T06 e caminho mínimo de T10 comprovados; rede/provedor roteirizado, canários de segredo, recuperação e revisão de efeitos aprovados. Sem conta real.

### Gate C — piloto pessoal read-only
Consentimento de conta/fonte/escopo, serviço e acesso privado; Google/Drive/Notion reais só nos escopos aprovados. Revogação e retenção verificadas. Sem saída automática para terceiros.

### Gate D — ações externas e canais
Cada integração com conta/app de teste, revisão do efeito, destino controlado, autorização específica, controles de replay e recuperação. Sem prometer envio/edição/Teams/Slack enquanto faltar acesso.

### Gate E — uso durável
Boot/restart/backup/restore/notificações, funcionamento fora da TUI e sessão nova comprovados; ativação agendada/serviço autorizada. Uma feature insegura fica desligada sem bloquear o uso das restantes.

Rollback: desligar novas admissões e rotinas, preservar journal e efeitos incertos, revogar referências/tokens, retornar cliente à versão compatível e restaurar apenas banco compatível. Rollback de código não desfaz e-mails, pagamentos, assinatura ou dados externos; reconciliar antes de qualquer compensação.

## 8. Definição de conclusão

- [ ] Todos C01–C24 mapeados e entregues com evidência verificável, ou explicitamente bloqueados por acesso/consentimento.
- [ ] Nenhum efeito duplicado, isolamento/segredo violado ou entrada não humana promovida a autorização nos controles negativos.
- [ ] Gates do escopo verdes, diff revisado e configuração/skills descobertas em sessão nova.
- [ ] Fluxos reais autorizados comprovados; mocks/fixtures não tratados como equivalência operacional.
- [ ] Nenhum deploy/release/custo/conta/serviço ativado por inferência.
- [ ] Relatório final separa Feito, Validado e Pendências; sem alegar equivalência completa se qualquer critério relevante estiver não verificado.

## 9. Próxima ação de implementação

Começar por **T01: contratos + caixa única no terminal**, depois T02/T03. É a menor entrega que melhora o dia a dia e cria base verificável para as demais. Não começar por um painel decorativo ou por ligar fontes pessoais sem autorização. O parent primeiro verifica estado e instruções atuais; lança uma lane 6.1-terra para T01 em worktree própria com aceites deste documento, sem fanout sobre contratos ainda abertos.
