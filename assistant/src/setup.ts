import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { KeyProtector } from './secrets/protector.ts';
import { probeDocker, type DockerRunner } from './computer/docker.ts';
import type { MemoryEntry, MemoryView } from './memory/projection.ts';

/**
 * Honest setup: a component is "ready" only after a cheap local probe actually exercised it, recently, with
 * evidence. Configuration alone (a saved credential, a model name, an endpoint) is "not verified". Nothing here
 * calls a paid model; an inference test exists only as an explicit opt-in with a declared cost.
 */
export type SetupStatus = 'ready' | 'not_verified' | 'needs_setup';
export type Observation =
  | { kind: 'missing' | 'invalid' | 'failed'; detail: string }
  | { kind: 'present'; detail: string }
  | { kind: 'exercised'; detail: string; evidence: string; at: number };
export type Probe = () => Promise<Observation>;
export type SetupComponent = { id: string; label: string; fix: string; capabilities: string[]; probe: Probe };
export type SetupItem = { id: string; label: string; status: SetupStatus; detail: string; fix: string; evidence?: string; checkedAt: string };
export type SetupOptions = { now?: () => number; timeoutMs?: number; maxAgeMs?: number };

const DAY = 24 * 3600_000;
const TIMEOUT = Symbol('timeout');

function classify(observation: Observation, now: number, maxAgeMs: number): { status: SetupStatus; detail: string; evidence?: string } {
  if (observation.kind !== 'exercised') return { status: observation.kind === 'present' ? 'not_verified' : 'needs_setup', detail: observation.detail };
  if (!observation.evidence) return { status: 'not_verified', detail: `${observation.detail} (sem evid\ência registrada)` };
  if (!(now - observation.at <= maxAgeMs)) return { status: 'not_verified', detail: `${observation.detail} (verifica\ç\ão antiga)`, evidence: observation.evidence };
  return { status: 'ready', detail: observation.detail, evidence: observation.evidence };
}

export async function checkSetup(components: readonly SetupComponent[], options: SetupOptions = {}): Promise<SetupItem[]> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  return Promise.all(components.map(async component => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof TIMEOUT>(resolve => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); });
    let result: { status: SetupStatus; detail: string; evidence?: string };
    try {
      const observation = await Promise.race([component.probe(), deadline]);
      result = observation === TIMEOUT
        ? { status: 'not_verified', detail: `Sem resposta em ${Math.round(timeoutMs / 1000)} s; o estado \é desconhecido.` }
        : classify(observation, now(), options.maxAgeMs ?? DAY);
    } catch {
      // Probe errors can carry paths or credentials; only the fact of failure is shown.
      result = { status: 'needs_setup', detail: 'A verifica\ç\ão falhou.' };
    } finally { clearTimeout(timer); }
    return { id: component.id, label: component.label, fix: component.fix, checkedAt: new Date(now()).toISOString(), ...result };
  }));
}

export type Capability = { capability: string; available: boolean; reason: string };
/** What still works. A declined ("Agora n\ão") component is labelled as such; nothing pretends to read it. */
export function capabilities(items: readonly SetupItem[], components: readonly SetupComponent[], declined: ReadonlySet<string>): Capability[] {
  const byId = new Map(items.map(item => [item.id, item]));
  return components.flatMap(component => component.capabilities.map(capability => {
    const item = byId.get(component.id);
    if (declined.has(component.id)) return { capability, available: false, reason: `${component.label}: Agora n\ão. Dispon\ível depois de configurar.` };
    if (item?.status === 'needs_setup') return { capability, available: false, reason: `${component.label} precisa de configura\ç\ão: ${component.fix}` };
    return { capability, available: true, reason: item?.status === 'ready' ? 'Verificado' : 'Configurado, n\ão verificado' };
  }));
}

export function storeProbe(path: string): Probe {
  return async () => {
    if (!existsSync(path)) return { kind: 'missing', detail: 'Banco de tarefas ainda n\ão criado.' };
    const db = new DatabaseSync(path, { readOnly: true });
    try { db.prepare('SELECT count(*) AS n FROM sqlite_master').get(); } finally { db.close(); }
    return { kind: 'exercised', detail: 'Banco local aberto e lido.', evidence: 'sqlite read-only SELECT', at: Date.now() };
  };
}

export function vaultProbe(protector: KeyProtector): Probe {
  return async () => {
    const canary = randomBytes(32);
    try {
      const back = await protector.unprotect(await protector.protect(canary));
      if (!back.equals(canary)) return { kind: 'failed', detail: 'A prote\ç\ão do sistema n\ão devolveu o mesmo valor.' };
    } catch { return { kind: 'failed', detail: 'Prote\ç\ão de chaves do sistema indispon\ível.' }; }
    return { kind: 'exercised', detail: 'Prote\ç\ão de chaves do sistema funcionando.', evidence: 'protect/unprotect round trip', at: Date.now() };
  };
}

export function dockerProbe(image: string, runner?: DockerRunner): Probe {
  return async () => {
    const result = await probeDocker(image, runner);
    if (!result.available) return { kind: 'missing', detail: result.reason === 'seccomp_missing' ? 'Docker sem seccomp.' : 'Docker n\ão est\á acess\ível.' };
    if (!result.imagePresent) return { kind: 'present', detail: `Docker ${result.serverVersion} dispon\ível; imagem ${image} ausente (baixar exige consentimento).` };
    return { kind: 'exercised', detail: `Docker ${result.serverVersion} com imagem ${image}.`, evidence: 'docker info + image inspect', at: Date.now() };
  };
}

const MODEL_REF = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export function modelProbe(ref: string | undefined): Probe {
  return async () => {
    if (!ref) return { kind: 'missing', detail: 'Nenhum modelo configurado.' };
    if (!MODEL_REF.test(ref)) return { kind: 'invalid', detail: 'Refer\ência de modelo inv\álida.' };
    return { kind: 'present', detail: `Modelo ${ref} configurado; nenhuma infer\ência foi feita para verificar.` };
  };
}

/** The only probe that calls a model. Built only with explicit consent and a declared cost; constructing it runs nothing. */
export function inferenceProbe(options: { declaredCost: string; consent: true; run: () => Promise<string> }): Probe {
  if (!options.declaredCost.trim()) throw new Error('inference test needs a declared cost');
  if (options.consent !== true) throw new Error('inference test needs explicit consent');
  return async () => {
    const reply = await options.run();
    return reply ? { kind: 'exercised', detail: `Infer\ência respondeu (custo declarado: ${options.declaredCost}).`, evidence: 'opt-in inference', at: Date.now() } : { kind: 'failed', detail: 'Infer\ência sem resposta.' };
  };
}

export function endpointProbe(url: string, fetchImpl: typeof fetch = fetch): Probe {
  return async () => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { kind: 'invalid', detail: 'Endere\ço inv\álido.' }; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return { kind: 'invalid', detail: 'Use http(s) sem credenciais no endere\ço.' };
    try {
      const res = await fetchImpl(parsed, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      await res.body?.cancel();
      if (!res.ok) return { kind: 'failed', detail: `O servi\ço respondeu HTTP ${res.status}.` };
    } catch { return { kind: 'failed', detail: 'O servi\ço n\ão respondeu.' }; }
    return { kind: 'exercised', detail: `Servi\ço em ${parsed.host} respondeu.`, evidence: `GET ${parsed.origin}${parsed.pathname}`, at: Date.now() };
  };
}

export type ConnectionState = { configured: boolean; expectedAccount?: string; observedAccount?: string; identityVerified: boolean; revoked: boolean; lastReadAt?: number };
/** Connections (Google, Drive, Notion...) report their own state; readiness needs the expected account and a real read. */
export function connectionProbe(state: () => ConnectionState, now: () => number = Date.now): Probe {
  return async () => {
    const s = state();
    if (!s.configured) return { kind: 'missing', detail: 'N\ão conectado.' };
    if (s.revoked) return { kind: 'failed', detail: 'Acesso revogado; conecte de novo.' };
    if (!s.identityVerified || !s.observedAccount || (s.expectedAccount !== undefined && s.observedAccount !== s.expectedAccount))
      return { kind: 'invalid', detail: 'A conta conectada n\ão \é a conta esperada ou n\ão foi confirmada.' };
    if (s.lastReadAt === undefined) return { kind: 'present', detail: `Conta ${s.observedAccount} conectada; nenhuma leitura feita ainda.` };
    return { kind: 'exercised', detail: `Conta ${s.observedAccount} leu dados.`, evidence: `read at ${new Date(s.lastReadAt).toISOString()}`, at: s.lastReadAt };
  };
}

export type DefaultSetup = {
  databasePath: string; protector: KeyProtector; docker?: DockerRunner; dockerImage?: string; model?: string;
  google?: () => ConnectionState; notifications?: Probe;
};
const disconnected = (): ConnectionState => ({ configured: false, identityVerified: false, revoked: false });
/** The checklist the service shows. Sources not wired yet report "not configured", never a guess. */
export function defaultComponents(options: DefaultSetup): SetupComponent[] {
  const major = Number(process.versions.node.split('.')[0]);
  return [
    { id: 'runtime', label: 'Node.js', fix: 'Instale Node.js 24 ou mais novo.', capabilities: ['service'],
      probe: async () => major >= 24 ? { kind: 'exercised', detail: `Node ${process.versions.node}.`, evidence: 'process.versions', at: Date.now() } : { kind: 'invalid', detail: `Node ${process.versions.node} \é antigo.` } },
    { id: 'model', label: 'Modelo', fix: 'Defina o modelo do executor no perfil; o teste de infer\ência \é opcional e tem custo declarado.', capabilities: ['agent-work'], probe: modelProbe(options.model) },
    { id: 'storage', label: 'Tarefas locais', fix: 'Inicie o servi\ço uma vez para criar o banco privado.', capabilities: ['tasks', 'routines', 'memory'], probe: storeProbe(options.databasePath) },
    { id: 'keys', label: 'Cofre de segredos', fix: 'Use Windows (DPAPI); outros sistemas ainda n\ão t\êm prote\ç\ão de chave suportada.', capabilities: ['secrets'], probe: vaultProbe(options.protector) },
    { id: 'isolation', label: 'Computador isolado', fix: 'Inicie o Docker com seccomp; baixar a imagem exige seu consentimento.', capabilities: ['computer'],
      probe: dockerProbe(options.dockerImage ?? 'node:22.23.4-alpine3.23', options.docker) },
    { id: 'google', label: 'Google (e-mail e agenda)', fix: 'Conecte a conta com consentimento; pessoal e DentAI s\ão conex\ões separadas.', capabilities: ['email-briefing', 'calendar'], probe: connectionProbe(options.google ?? disconnected) },
    { id: 'notifications', label: 'Notifica\ç\ões', fix: 'Autorize as notifica\ç\ões locais; sem isso os avisos ficam s\ó na caixa.', capabilities: ['alerts'],
      probe: options.notifications ?? (async () => ({ kind: 'missing', detail: 'Notifica\ç\ões n\ão autorizadas.' })) },
  ];
}

export type KnownItem = { sourceId: string; ref: string; source: string; text: string; observedAt: string; author: string; corrected: boolean; originalHash: string };
/** The first introduction: only what memory already holds, with provenance; corrections go through the memory view. */
export class Onboarding {
  private readonly view: MemoryView;
  constructor(view: MemoryView) { this.view = view; }
  introduce(refs: readonly { sourceId: string; ref: string }[]): { known: KnownItem[]; unknown: string[] } {
    const known: KnownItem[] = []; const unknown: string[] = [];
    for (const { sourceId, ref } of refs) {
      let entry: MemoryEntry;
      try { entry = this.view.read(sourceId, ref); } catch { unknown.push(`${sourceId}:${ref}`); continue; }
      known.push({ sourceId, ref, source: `${sourceId}:${ref}`, text: entry.current.text, observedAt: entry.original.observedAt, author: entry.original.author, corrected: entry.current.from === 'correction', originalHash: entry.originalHash });
    }
    return { known, unknown };
  }
  /** "Est\á certo": nothing to store; the original already is the record. */
  confirm(_item: KnownItem): void {}
  /** The memory view checks the operator authority and that the original is unchanged. */
  correct(item: KnownItem, text: string, reason: string, authority: object): void {
    this.view.correct({ sourceId: item.sourceId, ref: item.ref, originalHash: item.originalHash, text, kind: 'fact', reason }, authority);
  }
}
