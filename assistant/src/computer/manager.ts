import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { boundedInteger } from '../limits.ts';
import { allRows } from '../store/rows.ts';
import { dockerCli, type DockerRunner } from './docker.ts';

export type ComputerState = 'ready' | 'paused' | 'human';
export type Computer = { id: string; profileId: string; agentId: string; container: string; state: ComputerState; expiresAt: number };
export type ExecResult = { code: number; stdout: string; stderr: string; truncated: boolean };
export type ComputerOptions = {
  databasePath: string; owner: string; operatorAuthority: object; image: string;
  docker?: DockerRunner; now?: () => number; ttlMs?: number; memoryMb?: number; pids?: number; workMb?: number;
};

const OWNER_LABEL = 'optchat.computer.owner';
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_OUTPUT = 64 * 1024;
type Row = { id: string; profile: string; agent: string; container: string; state: ComputerState; expires: number };

function fail(code: string): never { throw new Error(code); }
function clip(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_OUTPUT ? { text: text.slice(0, MAX_OUTPUT), truncated: true } : { text, truncated: false };
}

/**
 * One disposable Linux computer per (owner, profile, agent): its own container and tmpfs workspace,
 * no network, no host mounts, no Docker socket, no capabilities, non-root, read-only root filesystem.
 * State lives in SQLite so a human takeover recorded by the host blocks agent reads in every process.
 * Only containers labelled with this manager's owner are ever started, stopped or removed.
 */
export class ComputerManager {
  private readonly db: DatabaseSync;
  private readonly update: StatementSync;
  private readonly docker: DockerRunner;
  private readonly now: () => number;
  private readonly options: Required<Pick<ComputerOptions, 'owner' | 'image' | 'ttlMs' | 'memoryMb' | 'pids' | 'workMb'>> & { authority: object };

  constructor(options: ComputerOptions) {
    if (!options.operatorAuthority || typeof options.operatorAuthority !== 'object' || !NAME.test(options.owner ?? '') || typeof options.image !== 'string' || !options.image) fail('invalid_options');
    this.options = {
      owner: options.owner, image: options.image, authority: options.operatorAuthority,
      ttlMs: boundedInteger(options.ttlMs, 30 * 60_000, 1_000, 24 * 3_600_000),
      memoryMb: boundedInteger(options.memoryMb, 512, 64, 8192),
      pids: boundedInteger(options.pids, 256, 16, 4096),
      workMb: boundedInteger(options.workMb, 256, 8, 8192),
    };
    this.docker = options.docker ?? dockerCli;
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS computers (id TEXT PRIMARY KEY, owner TEXT NOT NULL, profile TEXT NOT NULL, agent TEXT NOT NULL,
        container TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL);`);
    this.update = this.db.prepare('UPDATE computers SET state = ?, expires = ? WHERE id = ? AND owner = ?');
  }

  private row(id: string): Row {
    const row = this.db.prepare('SELECT id, profile, agent, container, state, expires FROM computers WHERE id = ? AND owner = ?').get(id, this.options.owner) as Row | undefined;
    return row ?? fail('computer_unknown');
  }
  private view(row: Row): Computer {
    return { id: row.id, profileId: row.profile, agentId: row.agent, container: row.container, state: row.state, expiresAt: row.expires };
  }
  private authorize(authority: object): void { if (authority !== this.options.authority) fail('unauthorized'); }
  private save(row: Row, state: ComputerState, expires = row.expires): void { this.update.run(state, expires, row.id, this.options.owner); }
  /** Pauses (`paused`) or unpauses (`ready`) the container; a no-op when it is already on that side. */
  private async toggle(id: string, want: 'paused' | 'ready'): Promise<void> {
    const row = this.row(id);
    if ((row.state === 'paused') === (want === 'paused')) return;
    const freeze = want === 'paused';
    if ((await this.docker([freeze ? 'pause' : 'unpause', row.container])).code !== 0) fail(freeze ? 'computer_pause_failed' : 'computer_resume_failed');
    this.save(row, want);
  }

  /** Label owner and status of a container by name, or undefined when it does not exist. */
  private async inspect(container: string): Promise<{ owner: string; status: string } | undefined> {
    const result = await this.docker(['inspect', '--type', 'container', '--format', `{{index .Config.Labels "${OWNER_LABEL}"}}|{{.State.Status}}`, container]);
    if (result.code !== 0) return undefined;
    const [owner, status] = result.stdout.trim().split('|');
    return { owner: owner ?? '', status: status ?? '' };
  }

  private runArgs(row: Pick<Row, 'id' | 'profile' | 'agent' | 'container'>): string[] {
    const { owner, image, memoryMb, pids, workMb } = this.options;
    return ['run', '--detach', '--pull', 'never', '--init', '--name', row.container, '--hostname', 'computer',
      '--label', `${OWNER_LABEL}=${owner}`, '--label', `optchat.computer.profile=${row.profile}`, '--label', `optchat.computer.agent=${row.agent}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
      '--ipc', 'private', '--pids-limit', String(pids), '--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb}m`, '--cpus', '1',
      '--tmpfs', `/work:rw,nosuid,nodev,size=${workMb}m,uid=1000,gid=1000,mode=0700`, '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
      '--workdir', '/work', '--env', 'HOME=/work', '--env', 'HISTFILE=/dev/null', image, 'tail', '-f', '/dev/null'];
  }

  /** Returns the agent's computer, creating its container when absent. Never pulls an image. */
  async create(profileId: string, agentId: string): Promise<Computer> {
    if (!NAME.test(profileId) || !NAME.test(agentId)) fail('invalid_request');
    const hash = createHash('sha256').update(JSON.stringify([this.options.owner, profileId, agentId])).digest('hex').slice(0, 20);
    const row: Row = { id: `cmp_${hash}`, profile: profileId, agent: agentId, container: `optchat-computer-${hash}`, state: 'ready', expires: this.now() + this.options.ttlMs };
    await this.ensureContainer(row);
    this.db.prepare(`INSERT INTO computers (id, owner, profile, agent, container, state, expires) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET expires = excluded.expires`).run(row.id, this.options.owner, row.profile, row.agent, row.container, row.state, row.expires);
    return this.view(this.row(row.id));
  }

  /** Starts the row's container, or reuses and restarts one this owner already has under that name. */
  private async ensureContainer(row: Row): Promise<void> {
    let existing = await this.inspect(row.container);
    if (!existing) {
      const run = await this.docker(this.runArgs(row), { timeoutMs: 60_000 });
      if (run.code === 0) return;
      existing = await this.inspect(row.container); // another process may have won the name
      if (!existing) fail(/No such image|not found|pull access/i.test(run.stderr) ? 'computer_image_missing' : 'computer_start_failed');
    }
    if (existing.owner !== this.options.owner) fail('computer_conflict');
    if ((existing.status === 'exited' || existing.status === 'created') && (await this.docker(['start', row.container])).code !== 0) fail('computer_start_failed');
  }

  get(id: string): Computer { return this.view(this.row(id)); }
  list(): Computer[] {
    return allRows<Row, Computer>(this.db, 'SELECT id, profile, agent, container, state, expires FROM computers WHERE owner = ? ORDER BY id', row => this.view(row), this.options.owner);
  }

  /** Throws the reason this computer cannot take agent work now (takeover, pause, expiry, wrong container). */
  admit(id: string, destination?: string): void { this.usable(id, destination); }

  private usable(id: string, destination?: string): Row {
    const row = this.row(id);
    if (destination !== undefined && destination !== row.container) fail('computer_destination_mismatch');
    if (row.state === 'human') fail('computer_human_control');
    if (row.state === 'paused') fail('computer_paused');
    if (row.expires <= this.now()) fail('computer_expired');
    return row;
  }

  /**
   * Runs argv inside the computer as uid 1000 in /work. This is the gateway's sink: call it only from
   * `gateway.dispatch` with the dispatched metadata. A human takeover or pause refuses it in any process.
   */
  async exec(id: string, argv: readonly string[], options: { destination?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) fail('invalid_request');
    const row = this.usable(id, options.destination);
    const timeoutMs = boundedInteger(options.timeoutMs, 30_000, 1_000, 10 * 60_000);
    this.db.prepare('UPDATE computers SET expires = ? WHERE id = ?').run(this.now() + this.options.ttlMs, id);
    // `timeout -s KILL` ends the process inside the container too; killing only the CLI would leave it running.
    const result = await this.docker(['exec', '--user', '1000:1000', '--workdir', '/work', row.container, 'timeout', '-s', 'KILL', String(Math.ceil(timeoutMs / 1000)), ...argv], { timeoutMs: timeoutMs + 10_000 });
    const stdout = clip(result.stdout); const stderr = clip(result.stderr);
    return { code: result.code, stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated };
  }

  /** Read-only view of the workspace listing, refused while a human holds control. */
  async capture(id: string): Promise<string> {
    const row = this.usable(id);
    const result = await this.docker(['exec', '--user', '1000:1000', row.container, 'ls', '-la', '/work']);
    if (result.code !== 0) fail('computer_capture_failed');
    return clip(result.stdout).text;
  }

  /** Freezes every process in the computer. Anyone may pause; resuming needs the operator. */
  async pause(id: string): Promise<void> { return this.toggle(id, 'paused'); }
  async resume(id: string, authority: object): Promise<void> {
    this.authorize(authority);
    return this.toggle(id, 'ready');
  }

  /**
   * The operator takes the computer (login, 2FA). From now on agent exec and capture are refused until `handBack`.
   * Returns the argv for the operator's own terminal; nothing typed there passes through the agent or its transcript.
   */
  async takeover(id: string, authority: object): Promise<{ argv: string[] }> {
    this.authorize(authority);
    const row = this.row(id);
    this.save(row, 'human');
    if (row.state === 'paused' && (await this.docker(['unpause', row.container])).code !== 0) fail('computer_resume_failed');
    return { argv: ['docker', 'exec', '--interactive', '--tty', '--user', '1000:1000', '--workdir', '/work', '--env', 'HISTFILE=/dev/null', row.container, 'sh'] };
  }
  handBack(id: string, authority: object): void {
    this.authorize(authority);
    const row = this.row(id);
    if (row.state !== 'human') fail('computer_not_in_takeover');
    this.save(row, 'ready', this.now() + this.options.ttlMs);
  }

  /** Removes one own computer after confirming its container still carries this owner's label. */
  async destroy(id: string): Promise<void> {
    const row = this.row(id);
    const existing = await this.inspect(row.container);
    if (existing && existing.owner !== this.options.owner) fail('computer_conflict');
    if (existing && (await this.docker(['rm', '--force', row.container])).code !== 0) fail('computer_remove_failed');
    this.db.prepare('DELETE FROM computers WHERE id = ? AND owner = ?').run(id, this.options.owner);
  }

  /** Destroys expired computers. One held by a human is kept until handed back. */
  async sweep(): Promise<string[]> {
    const expired = this.db.prepare("SELECT id FROM computers WHERE owner = ? AND expires <= ? AND state != 'human'").all(this.options.owner, this.now()) as { id: string }[];
    for (const { id } of expired) await this.destroy(id);
    return expired.map(row => row.id);
  }

  /** Removes every container labelled with this owner (including ones a crashed process left behind) and their rows. */
  async cleanup(): Promise<number> {
    const listed = await this.docker(['ps', '--all', '--filter', `label=${OWNER_LABEL}=${this.options.owner}`, '--format', '{{.Names}}']);
    if (listed.code !== 0) fail('computer_cleanup_failed');
    let removed = 0;
    for (const name of listed.stdout.split(/\r?\n/).filter(Boolean)) {
      if ((await this.inspect(name))?.owner !== this.options.owner) continue;
      if ((await this.docker(['rm', '--force', name])).code === 0) removed += 1;
    }
    this.db.prepare('DELETE FROM computers WHERE owner = ?').run(this.options.owner);
    return removed;
  }

  close(): void { this.db.close(); }
}

export function createComputers(options: ComputerOptions): ComputerManager { return new ComputerManager(options); }
