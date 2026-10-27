# Recarregar e continuar sem pedir “continua”

O agente pode salvar onde parou, carregar as extensões atualizadas e retomar a tarefa sozinho. Antes, o operador precisava fazer `/reload` e mandar outra mensagem para o agente voltar ao trabalho.

A ferramenta `self_reload` salva um checkpoint na sessão. Quando a resposta termina com sucesso, executa o reload nativo do Pi. A extensão nova assume a retomada e envia uma mensagem visível, identificada como evento da extensão — não como uma ordem nova do usuário.

## O que protege seu trabalho

- Bloqueia reload com shells gerenciados, agentes, importação, relatórios ou mensagens pendentes, conexão remota e efeitos incertos.
- Consulta o estado atual de pi-subagents. Se essa extensão estiver instalada sem o novo guard, bloqueia em vez de presumir que está ociosa.
- Confere sessão, diretório e perfil antes e depois da troca.
- Espera o reload inteiro terminar; `session_start` sozinho não prova que os outros recursos carregaram.
- Um cancelamento, erro, crash ou reload manual posterior não repete a retomada.
- A mensagem de retomada mantém a autorização original; não aprova publicação, troca de conta ou repetição de ações.

O reload não transporta jobs vivos, não reinicia o processo Pi e não atualiza dependências. Extensões de terceiros sem integração de readiness podem ter efeitos próprios no shutdown. A salvaguarda não é um sandbox.

## Uso e ativação

Autorize o reload da tarefa e peça ao agente para usar `self_reload` com o estado verificado, evidências e próximo passo. Consulte a skill [self-reload](../skills/self-reload/SKILL.md).

A primeira instalação precisa de um `/reload` manual ou sessão nova para disponibilizar a ferramenta e o guard de pi-subagents. Depois disso, o agente pode solicitar o próprio reload para atualizações compatíveis. Nenhum reload da sessão atual é feito durante os testes offline.

## Evidência e limites

Os checks `self-reload` e `self-reload-installed` executam uma ação descartável, recarregam extensões de verdade, retomam com código recém-carregado, inspecionam o resultado e produzem a resposta final. O efeito ocorre uma vez; um reload manual posterior não o repete. Provider roteirizado, rede externa proibida, perfil temporário.

`self-reload-mutations` remove guards em cópias descartáveis e exige que os testes falhem. Os arquivos reais não são alterados.

Isso prova o fluxo isolado no SDK, não a ativação na sessão interativa do operador. O campo `completed` registra que o turno da retomada terminou normalmente, não que toda a tarefa ou seus efeitos externos foram validados. A intenção, a resposta da ferramenta, o reload, a retomada e o resultado da tarefa são etapas diferentes.
