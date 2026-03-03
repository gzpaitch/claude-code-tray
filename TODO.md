# TODO - Claude Code Tray

## Robustez / Bugs

- [x] **Single instance lock** -- Usar `app.requestSingleInstanceLock()` para impedir múltiplas instâncias do app (múltiplos ícones na tray).
- [x] **Watch resiliente** -- Se os arquivos `stats-cache.json` ou `rate-limit-cache.json` não existem no startup, o `watch()` falha silenciosamente e nunca é reativado. Monitorar o diretório `~/.claude` e re-registrar watches quando os arquivos forem criados.
- [x] **Leitura assíncrona no refresh** -- `readUsage()` usa `readFileSync`, bloqueando a thread principal. Substituir por `readUsageAsync()` que já existe mas não é utilizada.

## Segurança

- [x] **Substituir `exec` por `spawn`** -- Os launchers usam `exec('start cmd /k "claude"')` com shell interpolation. Usar `spawn` ou `execFile` para evitar injection.

## UX

- [x] **Toggle de auto-start** -- O usuário não tem como desativar o auto-start pelo app. Adicionar um toggle no menu de contexto (ex: "Start with Windows ✓").
- [x] **Feedback de erro** -- Se o OAuth falhar ou o `stats-cache.json` não existir, mostrar feedback visual ao usuário (ex: item no menu ou tooltip indicando o problema).

## Código

- [x] **Extrair HTML para arquivo separado** -- `generateDetailsHtml()` tem ~300 linhas de template string inline no `main.ts`. Mover para um arquivo `.html` separado com placeholder injection.
- [x] **Remover intervalo de refresh duplicado** -- Existem dois `setInterval`: um de 60s (OAuth + tray) e outro de 30s (só tray). O de 30s é redundante pois o de 60s já chama `refreshTray()`.
- [ ] **`details-html.ts` monolítico** -- `generateDetailsHtml` tem ~300 linhas misturando CSS inline, lógica de dados e geração de HTML. Separar em: CSS em arquivo estático, funções de seção individuais (`buildRateLimitSection`, `buildTodaySection`, etc.).
- [ ] **Constantes de altura acopladas** -- `COLLAPSED_H = 420` e `EXPANDED_H = 720` no HTML gerado precisam estar sincronizadas com `winHeight = 420` em `main.ts`. Extrair para constantes compartilhadas.
- [ ] **`buildContextMenu` longa** -- Função de ~70 linhas que mistura condicionais, formatação e construção de estrutura. Dividir em funções auxiliares por seção.
- [ ] **`readUsage()` síncrono exportado sem uso** -- A função `readUsage()` (síncrona) está exportada mas não é chamada externamente. Remover ou tornar interna.
