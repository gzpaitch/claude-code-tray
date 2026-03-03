# Como o CodexBar Obtém Usage do Claude Code

Este documento descreve como o CodexBar obtém os valores de usage (uso) do Claude Code, incluindo os três métodos de fetch, endpoints API, estrutura de dados e fluxo de execução.

## Sumário

O CodexBar possui **3 métodos principais** para obter os dados de usage do Claude Code, configuráveis através de `ClaudeUsageDataSource`:

1. **OAuth API** - Usa o endpoint OAuth da Anthropic
2. **Web API (Cookies)** - Extrai cookies do navegador e consulta a API web
3. **CLI (PTY)** - Executa o CLI do Claude em um pseudo-terminal e faz scraping

---

## Métodos de Fetch

### 1. OAuth API (`ClaudeOAuthUsageFetcher.swift`)

#### Detalhes da Requisição

| Propriedade | Valor |
|------------|-------|
| **Endpoint** | `GET https://api.anthropic.com/api/oauth/usage` |
| **Timeout** | 30 segundos |
| **Autenticação** | Bearer Token (OAuth access token) |
| **Header Beta** | `anthropic-beta: oauth-2025-04-20` |

#### Código de Exemplo

```swift
var request = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
request.httpMethod = "GET"
request.timeoutInterval = 30
request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
request.setValue("application/json", forHTTPHeaderField: "Accept")
request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
request.setValue("CodexBar", forHTTPHeaderField: "User-Agent")
```

#### Resposta da API

```json
{
  "five_hour": {
    "utilization": 85,
    "resets_at": "2026-03-01T14:30:00.000Z"
  },
  "seven_day": {
    "utilization": 45,
    "resets_at": "2026-03-08T00:00:00.000Z"
  },
  "seven_day_opus": {
    "utilization": 60,
    "resets_at": "2026-03-08T00:00:00.000Z"
  },
  "seven_day_sonnet": {
    "utilization": 30,
    "resets_at": "2026-03-08T00:00:00.000Z"
  },
  "extra_usage": {
    "is_enabled": true,
    "monthly_limit": 5000,
    "used_credits": 2340,
    "utilization": 46.8,
    "currency": "USD"
  }
}
```

#### Estrutura de Dados

```swift
struct OAuthUsageResponse: Decodable {
    let fiveHour: OAuthUsageWindow?           // Usage de 5 horas (sessão atual)
    let sevenDay: OAuthUsageWindow?           // Usage semanal (todos os modelos)
    let sevenDayOAuthApps: OAuthUsageWindow?  // Usage via apps OAuth
    let sevenDayOpus: OAuthUsageWindow?       // Usage semanal específico para Opus
    let sevenDaySonnet: OAuthUsageWindow?     // Usage semanal específico para Sonnet
    let iguanaNecktie: OAuthUsageWindow?      // Usage experimental/beta
    let extraUsage: OAuthExtraUsage?          // Info sobre "Extra usage" (custos)
}

struct OAuthUsageWindow: Decodable {
    let utilization: Double?      // Porcentagem usada (0-100)
    let resetsAt: String?         // ISO8601 timestamp do reset
}

struct OAuthExtraUsage: Decodable {
    let isEnabled: Bool?          // Se extra usage está ativo
    let monthlyLimit: Double?     // Limite mensal em centavos
    let usedCredits: Double?      // Créditos usados em centavos
    let utilization: Double?      // Porcentagem usada
    let currency: String?         // Código da moeda (USD, EUR, etc.)
}
```

#### Códigos de Status

| Status | Ação |
|--------|------|
| 200 | Sucesso - decoda response |
| 401 | Unauthorized - prompt para reautenticar |
| 403 | Forbidden - retorna body do erro |
| Outro | ServerError - retorna código e body |

---

### 2. Web API (Cookies) (`ClaudeWebAPIFetcher.swift`)

#### Fluxo de Obtenção de Cookies

```
BrowserCookieClient
    │
    ├──> Tenta cache (CookieHeaderCache)
    │       └──> Se válido e não expirado → usa cache
    │
    └──> Extrai cookies dos navegadores
            ├──> Chrome
            ├──> Safari
            ├──> Firefox
            ├──> Edge
            └──> Brave (se configurado)
```

#### Ordem de Importação de Cookies

Definido em `ProviderDefaults.metadata[.claude]?.browserCookieOrder`:
- Safari (no macOS)
- Chrome
- Firefox
- Edge
- Brave

#### Cookies Necessários

```swift
// Cookie necessário para autenticação
sessionKey: String  // Formato: "sk-ant-..."
```

#### Endpoints da API Web

| Endpoint | Método | Propósito |
|----------|--------|-----------|
| `/api/organizations` | GET | Obter organização UUID |
| `/api/organizations/{org_id}/usage` | GET | Obter usage percentages |
| `/api/organizations/{org_id}/overage_spend_limit` | GET | Obter extra usage (custos) |
| `/api/account` | GET | Obter email e tipo de conta |

#### Requisições Detalhadas

##### 1. Obter Organização

```swift
GET https://claude.ai/api/organizations
Cookie: sessionKey=sk-ant-...
Accept: application/json
Timeout: 15s
```

**Resposta:**
```json
[
  {
    "uuid": "org-123456789",
    "name": "Acme Corp",
    "capabilities": ["chat", "api"]
  }
]
```

##### 2. Obter Usage

```swift
GET https://claude.ai/api/organizations/{org_id}/usage
Cookie: sessionKey=sk-ant-...
Accept: application/json
Timeout: 15s
```

**Resposta:**
```json
{
  "five_hour": {
    "utilization": 85,
    "resets_at": "2026-03-01T14:30:00.000Z"
  },
  "seven_day": {
    "utilization": 45,
    "resets_at": "2026-03-08T00:00:00.000Z"
  },
  "seven_day_opus": {
    "utilization": 60
  }
}
```

##### 3. Obter Extra Usage (Overage)

```swift
GET https://claude.ai/api/organizations/{org_id}/overage_spend_limit
Cookie: sessionKey=sk-ant-...
Accept: application/json
Timeout: 15s
```

**Resposta:**
```json
{
  "monthly_credit_limit": 500000,  // em centavos = $5000
  "currency": "USD",
  "used_credits": 234000,          // em centavos = $2340
  "is_enabled": true
}
```

##### 4. Obter Info da Conta

```swift
GET https://claude.ai/api/account
Cookie: sessionKey=sk-ant-...
Accept: application/json
Timeout: 15s
```

**Resposta:**
```json
{
  "email_address": "user@example.com",
  "memberships": [
    {
      "organization": {
        "uuid": "org-123456789",
        "name": "Acme Corp",
        "rate_limit_tier": "claude_max",
        "billing_type": "stripe"
      }
    }
  ]
}
```

#### Estrutura de Dados

```swift
public struct WebUsageData: Sendable {
    public let sessionPercentUsed: Double        // Usage de sessão (5h)
    public let sessionResetsAt: Date?            // Reset da sessão
    public let weeklyPercentUsed: Double?        // Usage semanal
    public let weeklyResetsAt: Date?             // Reset semanal
    public let opusPercentUsed: Double?          // Usage Opus específico
    public let extraUsageCost: ProviderCostSnapshot? // Extra usage
    public let accountOrganization: String?      // Nome da organização
    public let accountEmail: String?             // Email da conta
    public let loginMethod: String?              // "Claude Pro", "Claude Max", etc.
}

public struct ProviderCostSnapshot: Sendable {
    public let used: Double           // Valor usado (convertido de centavos)
    public let limit: Double          // Limite (convertido de centavos)
    public let currencyCode: String   // "USD", "EUR", etc.
    public let period: String         // "Monthly"
    public let resetsAt: Date?
    public let updatedAt: Date
}
```

#### Cache de Cookies

Os cookies são armazenados em `CookieHeaderCache` com os seguintes campos:
- `provider`: "claude"
- `cookieHeader`: "sessionKey=sk-ant-..."
- `sourceLabel`: "Safari", "Chrome", etc.
- `storedAt`: Timestamp do armazenamento

O cache é invalidado quando:
- Status 401/403 é recebido
- Cookie `sessionKey` não é encontrado
- Cookie não tem formato válido (não começa com "sk-ant-")

---

### 3. CLI (PTY) (`ClaudeStatusProbe.swift` + `ClaudeCLISession.swift`)

#### Como Funciona

O CodexBar executa o binário `claude` dentro de um **PTY (pseudo-terminal)** para poder interagir com a interface TUI do Claude CLI.

#### Fluxo de Execução

```
1. ClaudeCLISession.shared.ensureStarted()
   │
   ├──> Abre PTY (openpty)
   ├──> Inicia processo: claude --allowed-tools ""
   └──> Opcional: Usa watchdog (CodexBarClaudeWatchdog)

2. Envia comando: /usage
   │
   ├──> Captura output do PTY
   ├──> Auto-responde prompts de confiança
   ├──> Para quando detecta labels de usage
   └──> Envia Enter periodicamente para renderizar

3. Envia comando: /status (opcional)
   │
   └──> Captura info de conta

4. Parse do texto
   │
   ├──> Remove códigos ANSI
   ├──> Extrai percentages via regex
   ├──> Identifica labels (session, weekly, opus)
   └──> Extrai email, organização, plano
```

#### Sessão CLI Compartilhada

```swift
actor ClaudeCLISession {
    static let shared = ClaudeCLISession()

    private var process: Process?
    private var primaryFD: Int32 = -1
    private var primaryHandle: FileHandle?
    private var binaryPath: String?
    private var startedAt: Date?

    // Mantém sessão reutilizável para evitar cold-starts
}
```

#### Auto-Resposta de Prompts

```swift
private let promptSends: [String: String] = [
    "Do you trust the files in this folder?": "y\r",
    "Quick safety check:": "\r",
    "Yes, I trust this folder": "\r",
    "Ready to code here?": "\r",
    "Press Enter to continue": "\r",
]
```

#### Comandos Enviados

| Comando | Timeout | Idle Timeout | Stop On | Send Enter Every |
|---------|---------|--------------|---------|------------------|
| `/usage` | 20s | `nil` | Labels de usage | 0.8s |
| `/status` | 12s | 3.0s | - | - |

#### Substrings de Parada (para `/usage`)

```swift
let stopOnSubstrings = [
    "Current week (all models)",
    "Current week (Opus)",
    "Current week (Sonnet only)",
    "Current week (Sonnet)",
    "Current session",
    "Failed to load usage data",
    "failed to load usage data",
]
```

#### Parse de Percentages

```swift
// Regex para capturar percentages
let pattern = #"([0-9]{1,3}(?:\.[0-9]+)?)\p{Zs}*"%

// Keywords para determinar se é "used" ou "remaining"
let usedKeywords = ["used", "spent", "consumed"]
let remainingKeywords = ["left", "remaining", "available"]

// Se não há keyword clara, assume "remaining"
```

#### Extração de Labels

```swift
// Labels procurados no texto
"Current session"           → sessionPct
"Current week (all models)" → weeklyPct
"Current week (Opus)"       → opusPct
"Current week (Sonnet)"     → opusPct (fallback)
```

#### Fallback Order-Based

Se os labels não forem encontrados mas existem percentages, usa ordem:
1. Primeira percentage → session
2. Segunda percentage → weekly (se label existe)
3. Terceira percentage → opus (se label existe)

#### Estrutura de Dados

```swift
public struct ClaudeStatusSnapshot: Sendable {
    public let sessionPercentLeft: Int?
    public let weeklyPercentLeft: Int?
    public let opusPercentLeft: Int?
    public let accountEmail: String?
    public let accountOrganization: String?
    public let loginMethod: String?
    public let primaryResetDescription: String?
    public let secondaryResetDescription: String?
    public let opusResetDescription: String?
    public let rawText: String
}

public struct ClaudeAccountIdentity: Sendable {
    public let accountEmail: String?
    public let accountOrganization: String?
    public let loginMethod: String?
}
```

#### Regex para Email

```swift
// Pattern estrito
let emailPatterns = [
    #"Account:\s+([^\s@]+@[^\s@]+)"#,
    #"Email:\s+([^\s@]+@[^\s@]+)"#
]

// Pattern mais flexível
let looseEmailPatterns = [
    #"Account:\s+(\S+)"#,
    #"Email:\s+(\S+)"#
]

// Pattern final (fallback)
let genericPattern = #"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#
```

#### Regex para Organização

```swift
let orgPatterns = [
    #"Org:\s*(.+)"#,
    #"Organization:\s*(.+)"#
]
```

#### Extração de Login Method (Plano)

```swift
// 1. Tenta campo explícito
let explicit = extractFirst(pattern: #"login\s+method:\s*(.+)"#, text)

// 2. Tenta capturar "Claude <...>" (ex: Claude Max, Claude Pro)
let planPattern = #"(claude\s+[a-z0-9][a-z0-9\s._-]{0,24})"#

// 3. Exclui falsos positivos como "Claude Code v..."
```

---

## Estrutura de Dados Final

### ClaudeUsageSnapshot

```swift
public struct ClaudeUsageSnapshot: Sendable {
    public let primary: RateWindow           // 5-hour session (principal)
    public let secondary: RateWindow?        // 7-day window (todos)
    public let opus: RateWindow?            // 7-day Opus específico
    public let providerCost: ProviderCostSnapshot? // Extra usage
    public let updatedAt: Date
    public let accountEmail: String?
    public let accountOrganization: String?
    public let loginMethod: String?
    public let rawText: String?
}

public struct RateWindow: Sendable {
    public let percentLeft: Int?            // 0-100
    public let limit: Int?                  // Tokens ou valor absoluto
    public let used: Int?                   // Tokens ou valor absoluto
    public let resetsAt: Date?              // Timestamp do reset
    public let windowType: UsageWindowType  // .session, .weekly
}
```

### ClaudeUsageDataSource

```swift
public enum ClaudeUsageDataSource: String, CaseIterable {
    case auto   // Tenta OAuth → Web → CLI (com fallback)
    case oauth  // Apenas OAuth API
    case web    // Apenas Web API (cookies)
    case cli    // Apenas CLI (PTY)
}
```

---

## Configurações

### Provider Implementation

```swift
struct ClaudeProviderImplementation: ProviderImplementation {
    let id: UsageProvider = .claude
    let supportsLoginFlow: Bool = true

    // Configurações observadas
    func observeSettings(_ settings: SettingsStore) {
        _ = settings.claudeUsageDataSource
        _ = settings.claudeCookieSource          // .auto, .manual, .off
        _ = settings.claudeCookieHeader
        _ = settings.claudeOAuthKeychainPromptMode
        _ = settings.claudeOAuthKeychainReadStrategy
        _ = settings.claudeWebExtrasEnabled
    }
}
```

### Cookie Source

```swift
public enum ProviderCookieSource: String {
    case auto    // Importa automaticamente dos navegadores
    case manual  // Usuário cola Cookie header manualmente
    case off     // Desabilitado
}
```

### Keychain Prompt Mode

```swift
public enum ClaudeOAuthKeychainPromptMode: String {
    case never              // Nunca pede credenciais do keychain
    case onlyOnUserAction   // Apenas em ação do usuário
    case always             // Sempre permite prompts
}
```

---

## Fluxo de Dados Completo

```
┌─────────────────────────────────────────────────────────────┐
│                    ClaudeUsageFetcher                       │
│                  (Coordenador Central)                      │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  OAuth API      │ │   Web API       │ │    CLI (PTY)    │
│                 │ │                 │ │                 │
│ • Token OAuth   │ │ • Browser Co... │ │ • claude binary │
│ • /oauth/usage  │ │ • /api/orgs     │ │ • /usage comm.. │
│ • 30s timeout   │ │ • /api/usage    │ │ • /status comm..│
│ • JSON response │ │ • Cookie cache  │ │ • PTY capture   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
          │                   │                   │
          └───────────────────┼───────────────────┘
                              ▼
                  ┌─────────────────────┐
                  │ ClaudeUsageSnapshot │
                  │                     │
                  │ • primary: 5h      │
                  │ • secondary: 7d    │
                  │ • opus: 7d         │
                  │ • cost: extra      │
                  │ • identity         │
                  └─────────────────────┘
                              │
                              ▼
                  ┌─────────────────────┐
                  │     UsageStore      │
                  │   (Armazenamento)   │
                  └─────────────────────┘
```

---

## Ordem de Fallback (Modo Auto)

Quando `claudeUsageDataSource = .auto`:

```
1. Tenta OAuth
   ├──> Sucesso → usa dados
   └──> Falha → próxima

2. Tenta Web API (cookies)
   ├──> Tenta cache
   ├──> Extrai cookies dos navegadores
   ├──> Sucesso → usa dados
   └──> Falha → próxima

3. Tenta CLI (PTY)
   ├──> Verifica se claude está instalado
   ├──> Executa /usage e /status
   ├──> Parse do texto
   └──> Sucesso ou erro final
```

---

## Tratamento de Erros

### OAuth Errors

```swift
enum ClaudeOAuthFetchError {
    case unauthorized           // 401 → run `claude` to re-auth
    case invalidResponse        // JSON inválido
    case serverError(Int, String?) // 4xx, 5xx com body
    case networkError(Error)    // Erro de rede
}
```

### Web API Errors

```swift
enum FetchError {
    case noSessionKeyFound      // Cookie não encontrado
    case invalidSessionKey      // Formato inválido
    case notSupportedOnThisPlatform // Apenas macOS
    case networkError(Error)
    case invalidResponse        // Parse falhou
    case unauthorized           // 401/403
    case serverError(statusCode)
    case noOrganization         // Org não encontrada
}
```

### CLI Errors

```swift
enum ClaudeStatusProbeError {
    case claudeNotInstalled     // Binary não encontrado
    case parseFailed(String)    // Parse do texto falhou
    case timedOut               // Comando excedeu timeout
}
```

---

## Arquivos Chave

| Arquivo | Propósito |
|---------|-----------|
| `ClaudeUsageFetcher.swift` | Coordenador principal |
| `ClaudeUsageDataSource.swift` | Enum de fontes de dados |
| `ClaudeOAuthUsageFetcher.swift` | Fetch via OAuth API |
| `ClaudeWebAPIFetcher.swift` | Fetch via Web API + cookies |
| `ClaudeStatusProbe.swift` | Parse e fetch via CLI |
| `ClaudeCLISession.swift` | Sessão PTY compartilhada |
| `ClaudeProviderImplementation.swift` | Provider UI settings |
| `ClaudeOAuthCredentials.swift` | Credenciais OAuth do keychain |
| `CookieHeaderCache.swift` | Cache de cookies |

---

## Debug

### Variáveis de Ambiente

```bash
# Habilita dump de parse do CLI
DEBUG_CLAUDE_DUMP=1

# Desabilita watchdog do Claude
CODEXBAR_DISABLE_CLAUDE_WATCHDOG=1
```

### Logs de Categoria

```swift
LogCategories.claudeProbe     // Probe CLI
LogCategories.claudeCLI       // Sessão CLI
LogCategories.claudeOAuth     // OAuth operations
```

### Testar Manualmente

```bash
# Verificar se claude está instalado
which claude

# Verificar usage via CLI
claude --allowed-tools "" <<< "/usage"

# Verificar status
claude --allowed-tools "" <<< "/status"

# Verificar OAuth token (do keychain)
/usr/bin/security find-generic-password \
  -s "claude-oauth-credentials" \
  -w | jq .access_token
```

---

## Referências

- **Documentação Claude Code**: https://code.claude.com/docs/en/overview
- **API Anthropic**: https://docs.anthropic.com/
- **CodexBar Repository**: https://github.com/[username]/CodexBar

---

*Documento gerado em 2026-03-01*
