import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { scrubSecrets } from './secret-scrub.ts';

export type OAuthFamily = 'anthropic' | 'openai-codex';

export interface StoredCredential {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
  accountId?: string;
}

export interface AuthStorageLike {
  modify?: (provider: string, fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined> | StoredCredential | undefined) => Promise<unknown>;
  set?: (provider: string, credential: StoredCredential) => Promise<void> | void;
  reload?: () => void;
}

export interface OAuthLoginInteraction {
  signal: AbortSignal;
  notify: (event: Record<string, unknown>) => void;
  prompt: (request: Record<string, unknown>) => Promise<string>;
}

export interface OAuthProviderDriver {
  login: (interaction: OAuthLoginInteraction) => Promise<StoredCredential>;
}

export interface ResumePrompt {
  text: string;
  thread: string | null;
  channel: string | null;
  id?: string;
  ts?: string;
}

export interface LoginStepResult {
  text: string;
  provider?: string;
  resumePrompt?: ResumePrompt;
  choices?: readonly string[];
}

export interface LoginCompletionEvent {
  ok: boolean;
  provider: string;
  text: string;
  resumePrompt?: ResumePrompt;
}

export interface RemoteLoginOptions {
  agentDir?: string;
  now?: () => number;
  ttlMs?: number;
  authStorage?: () => AuthStorageLike | undefined;
  oauthDriver?: (family: OAuthFamily) => OAuthProviderDriver | undefined;
  onUpdated?: (provider: string, options: { skipPendingResume: boolean }) => void;
  onBackgroundComplete?: (event: LoginCompletionEvent) => void;
}

const DEFAULT_TTL_MS = 15 * 60_000;
const ANTHROPIC_PLACEHOLDER = 'sk-ant-oat01-pi-multi-account-proxy';
const GENERIC_PLACEHOLDER = 'pi-multi-account-proxy';
const AUTH_ERROR_RE = /authentication_error|oauth access token has expired|token has expired|token expired|expired token|token has been invalidated|invalid_grant|re-authenticate|invalid x-api-key|invalid api[- ]key|refresh_token_reused|\b401\b.*(?:auth|token|unauthorized|key)/i;
const CANCEL_RE = /^(?:cancelar|cancela|cancel)$/i;

export function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

export function isAuthExpiryError(message: string | undefined): boolean {
  return typeof message === 'string' && AUTH_ERROR_RE.test(message);
}

export function oauthFamilyFor(provider: string | undefined): OAuthFamily | undefined {
  if (!provider) return undefined;
  if (provider === 'anthropic' || /^anthropic-account-\d+$/.test(provider)) return 'anthropic';
  if (provider === 'openai-codex' || /^openai-codex-account-\d+$/.test(provider)) return 'openai-codex';
  return undefined;
}

export function accountLabel(provider: string): string {
  const match = /^(.*?)-account-(\d+)$/.exec(provider);
  const base = match?.[1] ?? provider;
  const family = base === 'anthropic' ? 'Claude' : base === 'openai-codex' ? 'Codex' : base;
  return `${family} conta ${match?.[2] ?? '1'}`;
}

export function isProxyPlaceholder(entry: StoredCredential | undefined): boolean {
  if (entry?.type !== 'api_key' || typeof entry.key !== 'string') return false;
  if (entry.key === ANTHROPIC_PLACEHOLDER || entry.key === GENERIC_PLACEHOLDER) return true;
  const parts = entry.key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf8')) as Record<string, unknown>;
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    return auth?.chatgpt_account_id === GENERIC_PLACEHOLDER;
  } catch {
    return false;
  }
}

export function looksLikeOAuthCode(text: string): boolean {
  const value = text.trim();
  if (!value || /\s/.test(value)) return false;
  if (/^https?:\/\/[^\s]*[?&]code=[^&\s]+/i.test(value)) return true;
  if (/^[A-Za-z0-9._~-]{12,}#[A-Za-z0-9._~-]{12,}$/.test(value)) return true;
  if (/^code=[^&\s]+/i.test(value)) return true;
  return /^[A-Za-z0-9._~-]{24,}$/.test(value);
}

function readJsonRecord(file: string): Record<string, StoredCredential> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, StoredCredential> : {};
  } catch {
    return {};
  }
}

function writeSecretJson(file: string, data: Record<string, StoredCredential>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.optchat-login.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

export function readStoredAuth(agentDir = defaultAgentDir()): {
  raw: Record<string, StoredCredential>;
  sidecar: Record<string, StoredCredential>;
  merged: Record<string, StoredCredential>;
} {
  const raw = readJsonRecord(join(agentDir, 'auth.json'));
  const sidecar = readJsonRecord(join(agentDir, 'pi-multi-account-proxy-oauth.json'));
  const merged: Record<string, StoredCredential> = { ...raw };
  for (const [id, entry] of Object.entries(sidecar)) {
    if (entry?.type === 'oauth' && (isProxyPlaceholder(merged[id]) || !merged[id])) merged[id] = entry;
  }
  return { raw, sidecar, merged };
}

export function isRealApiKeySlot(provider: string, agentDir = defaultAgentDir()): boolean {
  const { raw } = readStoredAuth(agentDir);
  const entry = raw[provider];
  return entry?.type === 'api_key' && !isProxyPlaceholder(entry);
}

export async function persistOAuthCredential(
  provider: string,
  credential: StoredCredential,
  options: { agentDir?: string; authStorage?: AuthStorageLike } = {},
): Promise<void> {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const authPath = join(agentDir, 'auth.json');
  const sidecarPath = join(agentDir, 'pi-multi-account-proxy-oauth.json');
  const next: StoredCredential = { ...credential, type: 'oauth' };

  const writeSidecar = () => {
    const sidecar = readJsonRecord(sidecarPath);
    sidecar[provider] = next;
    writeSecretJson(sidecarPath, sidecar);
  };

  if (typeof options.authStorage?.modify === 'function') {
    await options.authStorage.modify(provider, async stored => {
      if (isProxyPlaceholder(stored)) {
        writeSidecar();
        return undefined;
      }
      if (stored?.type === 'api_key') {
        throw new Error(`${provider} usa API key; não foi sobrescrita por OAuth.`);
      }
      return next;
    });
  } else {
    const raw = readJsonRecord(authPath);
    const stored = raw[provider];
    if (isProxyPlaceholder(stored)) {
      writeSidecar();
    } else if (stored?.type === 'api_key') {
      throw new Error(`${provider} usa API key; não foi sobrescrita por OAuth.`);
    } else if (typeof options.authStorage?.set === 'function') {
      await options.authStorage.set(provider, next);
    } else {
      raw[provider] = next;
      writeSecretJson(authPath, raw);
    }
  }
  options.authStorage?.reload?.();
}

function defaultOAuthDriver(family: OAuthFamily): OAuthProviderDriver | undefined {
  const provider = builtinProviders().find(item => item.id === family);
  const oauth = provider?.auth?.oauth;
  if (!oauth || typeof oauth.login !== 'function') return undefined;
  return { login: interaction => oauth.login(interaction as never) as Promise<StoredCredential> };
}

function normalizeShorthand(query: string): string {
  const clean = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const claudeNum = /^(?:claude|anthropic)[\s_-]*(?:conta[\s_-]*|account[\s_-]*)?(\d+)$/.exec(clean);
  if (claudeNum) return claudeNum[1] === '1' ? 'anthropic' : `anthropic-account-${claudeNum[1]}`;
  const codexNum = /^(?:codex|openai-codex)[\s_-]*(?:conta[\s_-]*|account[\s_-]*)?(\d+)$/.exec(clean);
  if (codexNum) return codexNum[1] === '1' ? 'openai-codex' : `openai-codex-account-${codexNum[1]}`;
  if (clean === 'claude') return 'anthropic';
  if (clean === 'codex') return 'openai-codex';
  return clean;
}

export function resolveLoginAccount(
  query: string,
  known: readonly string[],
  invalidated: readonly string[],
  agentDir = defaultAgentDir(),
): { provider: string } | { candidates: string[]; message: string } {
  const oauthKnown = [...new Set([...known, ...invalidated])].filter(id => oauthFamilyFor(id) && !isRealApiKeySlot(id, agentDir)).sort();
  const oauthInvalid = invalidated.filter(id => oauthFamilyFor(id) && !isRealApiKeySlot(id, agentDir)).sort();
  const trimmed = query.trim();
  if (!trimmed) {
    if (oauthInvalid.length === 1) return { provider: oauthInvalid[0]! };
    if (oauthKnown.length === 1) return { provider: oauthKnown[0]! };
    const list = oauthInvalid.length ? oauthInvalid : oauthKnown;
    if (!list.length) {
      return { candidates: [], message: 'Nenhuma conta OAuth encontrada para reconectar. Use `/login` no terminal.' };
    }
    const lines = list.map(id => `• *${accountLabel(id)}* (\`${id}\`)${oauthInvalid.includes(id) ? ' — ⚠️ expirada' : ''}`);
    return {
      candidates: list,
      message: ['Qual conta você quer reconectar? Mande *login <conta>*:', ...lines].join('\n'),
    };
  }
  const normalized = normalizeShorthand(trimmed);
  if (oauthFamilyFor(normalized)) {
    if (normalized === 'anthropic' && isRealApiKeySlot('anthropic', agentDir)) {
      const alt = oauthKnown.filter(id => oauthFamilyFor(id) === 'anthropic');
      if (alt.length === 1 && trimmed.toLowerCase() === 'claude') return { provider: alt[0]! };
    }
    return { provider: normalized };
  }
  const partial = oauthKnown.filter(id => id.toLowerCase().includes(normalized));
  if (partial.length === 1) return { provider: partial[0]! };
  return {
    candidates: oauthKnown,
    message: `Não reconheci a conta "${trimmed}". Contas OAuth disponíveis: ${oauthKnown.map(id => `\`${id}\``).join(', ') || 'nenhuma'}.`,
  };
}

export function authFailureFromMessages(
  messages: readonly unknown[],
  fallbackProvider?: string,
): { provider?: string; errorMessage: string } | undefined {
  const last = [...messages].reverse().find(m => (m as { role?: unknown })?.role === 'assistant') as
    | { stopReason?: string; errorMessage?: string; provider?: string }
    | undefined;
  if (!last || last.stopReason !== 'error' || !isAuthExpiryError(last.errorMessage)) return undefined;
  return {
    provider: typeof last.provider === 'string' && last.provider ? last.provider : fallbackProvider,
    errorMessage: last.errorMessage!,
  };
}

interface PendingLogin {
  provider: string;
  family: OAuthFamily;
  mode: 'copy_code' | 'device_code';
  startedAt: number;
  expiresAt: number;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  submitCode?: (code: string) => void;
  finished: Promise<StoredCredential>;
  resumePrompt?: ResumePrompt;
  url?: string;
  userCode?: string;
}

export class RemoteLoginManager {
  private pending: PendingLogin | undefined;
  private readonly agentDir: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly authStorage: () => AuthStorageLike | undefined;
  private readonly oauthDriver: (family: OAuthFamily) => OAuthProviderDriver | undefined;
  private readonly onUpdated: (provider: string, options: { skipPendingResume: boolean }) => void;
  private readonly onBackgroundComplete: (event: LoginCompletionEvent) => void;

  constructor(options: RemoteLoginOptions = {}) {
    this.agentDir = options.agentDir ?? defaultAgentDir();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.authStorage = options.authStorage ?? (() => undefined);
    this.oauthDriver = options.oauthDriver ?? defaultOAuthDriver;
    this.onUpdated = options.onUpdated ?? (() => {});
    this.onBackgroundComplete = options.onBackgroundComplete ?? (() => {});
  }

  get activeProvider(): string | undefined {
    this.expireIfStale();
    return this.pending?.provider;
  }

  stop(): void {
    this.clearPending(true);
  }

  private expireIfStale(): void {
    if (this.pending && this.now() >= this.pending.expiresAt) this.clearPending(true);
  }

  private clearPending(abort: boolean): void {
    const current = this.pending;
    this.pending = undefined;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    if (abort) current.abort.abort();
  }

  knownProviders(extra: readonly string[] = []): string[] {
    const { raw, sidecar } = readStoredAuth(this.agentDir);
    return [...new Set([...Object.keys(raw), ...Object.keys(sidecar), ...extra])].sort();
  }

  canRemoteLogin(provider: string): boolean {
    return !!oauthFamilyFor(provider) && !isRealApiKeySlot(provider, this.agentDir);
  }

  resolveAccount(query: string, extraKnown: readonly string[], invalidated: readonly string[]) {
    return resolveLoginAccount(query, this.knownProviders(extraKnown), invalidated, this.agentDir);
  }

  async start(
    provider: string,
    options: { reason?: 'expired' | 'manual'; resumePrompt?: ResumePrompt } = {},
  ): Promise<LoginStepResult> {
    this.expireIfStale();
    const family = oauthFamilyFor(provider);
    const label = accountLabel(provider);
    if (!family) {
      return {
        text: `🔐 *${label}* (\`${provider}\`) não suporta login remoto por aqui. Rode \`/login\` no terminal.`,
      };
    }
    if (isRealApiKeySlot(provider, this.agentDir)) {
      return {
        text: `🔐 *${label}* (\`${provider}\`) usa API key. Por segurança, atualize a chave no terminal com \`/login\`.`,
      };
    }
    const driver = this.oauthDriver(family);
    if (!driver) {
      return {
        text: `🔐 Não encontrei o fluxo OAuth para *${label}* (\`${provider}\`) nesta versão do Pi. Rode \`/login\` no terminal.`,
      };
    }

    this.clearPending(true);
    const abort = new AbortController();
    let resolveReady!: (info: { mode: 'copy_code'; url: string } | { mode: 'device_code'; url: string; userCode: string }) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<{ mode: 'copy_code'; url: string } | { mode: 'device_code'; url: string; userCode: string }>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let readySettled = false;
    let submitCode: ((code: string) => void) | undefined;
    let rejectCode: ((error: Error) => void) | undefined;

    const interaction: OAuthLoginInteraction = {
      signal: abort.signal,
      notify: event => {
        if (readySettled) return;
        if (event.type === 'auth_url' && typeof event.url === 'string') {
          readySettled = true;
          resolveReady({ mode: 'copy_code', url: event.url });
        } else if (event.type === 'device_code' && typeof event.verificationUri === 'string' && typeof event.userCode === 'string') {
          readySettled = true;
          resolveReady({ mode: 'device_code', url: event.verificationUri, userCode: event.userCode });
        }
      },
      prompt: request => {
        if (request.type === 'select') {
          return Promise.resolve(family === 'anthropic' ? 'copy_code' : 'device_code');
        }
        return new Promise<string>((resolve, reject) => {
          if (abort.signal.aborted) { reject(new Error('Login cancelled')); return; }
          submitCode = resolve;
          rejectCode = reject;
          abort.signal.addEventListener('abort', () => reject(new Error('Login cancelled')), { once: true });
        });
      },
    };

    const finished = driver.login(interaction);
    void finished.catch(error => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
    });

    let info: { mode: 'copy_code'; url: string } | { mode: 'device_code'; url: string; userCode: string };
    try {
      info = await ready;
    } catch (error) {
      abort.abort();
      const why = scrubSecrets(error instanceof Error ? error.message : String(error));
      return {
        text: `🔐 Não consegui iniciar o login em *${label}* (\`${provider}\`): ${why}. Tente *login ${provider}* de novo ou rode \`/login\` no terminal.`,
      };
    }

    const startedAt = this.now();
    const pending: PendingLogin = {
      provider,
      family,
      mode: info.mode,
      startedAt,
      expiresAt: startedAt + this.ttlMs,
      abort,
      submitCode: code => submitCode?.(code),
      finished,
      resumePrompt: options.resumePrompt,
      url: info.url,
      ...(info.mode === 'device_code' ? { userCode: info.userCode } : {}),
    };
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      this.clearPending(true);
      rejectCode?.(new Error('Login expired'));
    }, this.ttlMs);
    pending.timer.unref?.();
    this.pending = pending;

    if (info.mode === 'device_code') {
      void finished.then(async credential => {
        if (this.pending !== pending) return;
        const resumePrompt = pending.resumePrompt;
        await this.completeAndPersist(pending, credential);
        this.onBackgroundComplete({
          ok: true,
          provider,
          text: `✅ *Login concluído em ${label}* (\`${provider}\`).${resumePrompt ? ' Retomando sua última mensagem.' : ' Conta pronta para uso.'}`,
          resumePrompt,
        });
      }, error => {
        if (this.pending !== pending) return;
        this.clearPending(false);
        if (abort.signal.aborted) return;
        const why = scrubSecrets(error instanceof Error ? error.message : String(error));
        this.onBackgroundComplete({
          ok: false,
          provider,
          text: `❌ Login de *${label}* (\`${provider}\`) falhou ou expirou (${why}). Mande *login ${provider}* para tentar de novo.`,
        });
      });
    }

    const head = options.reason === 'expired'
      ? `🔐 *Sessão expirada em ${label}* (\`${provider}\`).`
      : `🔐 *Reconectar ${label}* (\`${provider}\`).`;
    if (info.mode === 'copy_code') {
      return {
        provider,
        text: [
          head,
          '',
          `1. Abra este link e faça login na conta certa:\n${info.url}`,
          '2. Copie o código exibido pela Anthropic (`código#estado`) e *cole aqui nesta DM* (ou mande *cancelar*).',
          options.resumePrompt ? '\n_Assim que você colar o código, salvo o login e retomo sua última mensagem._' : '',
        ].filter(Boolean).join('\n'),
      };
    }
    return {
      provider,
      text: [
        head,
        '',
        `1. Abra ${info.url}`,
        `2. Digite o código: \`${info.userCode}\``,
        '',
        '_Assim que você autorizar no navegador, salvo o login automaticamente e aviso aqui (ou mande *cancelar*)._',
      ].join('\n'),
    };
  }

  private async completeAndPersist(pending: PendingLogin, credential: StoredCredential): Promise<void> {
    if (pending.timer) clearTimeout(pending.timer);
    if (this.pending === pending) this.pending = undefined;
    await persistOAuthCredential(pending.provider, credential, {
      agentDir: this.agentDir,
      authStorage: this.authStorage(),
    });
    this.onUpdated(pending.provider, { skipPendingResume: Boolean(pending.resumePrompt) });
  }

  async tryConsumeInput(text: string): Promise<LoginStepResult | undefined> {
    this.expireIfStale();
    const pending = this.pending;
    if (!pending) return undefined;
    const trimmed = text.trim();
    if (CANCEL_RE.test(trimmed)) {
      this.clearPending(true);
      return { text: `Login de *${accountLabel(pending.provider)}* cancelado.` };
    }
    if (pending.mode !== 'copy_code' || !looksLikeOAuthCode(trimmed)) return undefined;
    pending.submitCode?.(trimmed);
    const label = accountLabel(pending.provider);
    try {
      const credential = await pending.finished;
      const resumePrompt = pending.resumePrompt;
      await this.completeAndPersist(pending, credential);
      return {
        provider: pending.provider,
        resumePrompt,
        text: `✅ *Login concluído em ${label}* (\`${pending.provider}\`).${resumePrompt ? ' Retomando sua última mensagem.' : ' Conta pronta para uso.'}`,
      };
    } catch (error) {
      if (this.pending === pending) this.clearPending(false);
      const why = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 240);
      return {
        provider: pending.provider,
        text: `❌ Não consegui concluir o login em *${label}* (\`${pending.provider}\`): ${why}. Mande *login ${pending.provider}* para gerar um link novo.`,
      };
    }
  }

  async handleAuthFailure(
    provider: string | undefined,
    errorMessage: string,
    resumePrompt?: ResumePrompt,
  ): Promise<LoginStepResult> {
    if (provider && oauthFamilyFor(provider) && !isRealApiKeySlot(provider, this.agentDir)) {
      if (this.pending?.provider === provider && this.pending.url && this.now() < this.pending.expiresAt) {
        if (resumePrompt) this.pending.resumePrompt = resumePrompt;
        const label = accountLabel(provider);
        return {
          provider,
          text: this.pending.mode === 'copy_code'
            ? `🔐 *${label}* (\`${provider}\`) ainda aguarda login. Abra o link enviado acima e cole o código aqui (ou mande *login ${provider}* para gerar outro).`
            : `🔐 *${label}* (\`${provider}\`) ainda aguarda autorização em ${this.pending.url} com o código \`${this.pending.userCode}\`.`,
        };
      }
      return this.start(provider, { reason: 'expired', resumePrompt });
    }
    const label = provider ? `*${accountLabel(provider)}* (\`${provider}\`)` : 'a conta atual';
    const isKey = /x-api-key|api[- ]key/i.test(errorMessage) || (provider ? isRealApiKeySlot(provider, this.agentDir) : false);
    return {
      ...(provider ? { provider } : {}),
      text: isKey
        ? `🔐 *Autenticação recusada em ${label}* (chave de API inválida). Atualize a chave no terminal com \`/login\` ou troque de conta com *modelo*.`
        : `🔐 *Sessão expirada em ${label}.* Mande *login* aqui na DM ou rode \`/login\` no terminal para reconectar.`,
    };
  }
}
