import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { boundedInteger } from '../limits.ts';
import { allRows } from '../store/rows.ts';
import { dockerCli, type DockerRunner } from './docker.ts';
import { cleanupComputers, removeComputer } from './removal.ts';

export type ComputerState = 'ready' | 'paused' | 'human' | 'graphical' | 'transition' | 'removing';
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
        container TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_operations (token TEXT PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_lifecycle (id TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_graphical (id TEXT PRIMARY KEY, generation TEXT NOT NULL, container TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'uncertain', target TEXT);
      CREATE TABLE IF NOT EXISTS computer_owner_cleanup (owner TEXT PRIMARY KEY, token TEXT NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(computer_graphical)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'phase')) this.db.exec("ALTER TABLE computer_graphical ADD COLUMN phase TEXT NOT NULL DEFAULT 'uncertain'");
    if (!columns.some(column => column.name === 'target')) this.db.exec('ALTER TABLE computer_graphical ADD COLUMN target TEXT');
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
  private reserveLifecycle(id: string): string {
    const token = randomUUID();
    const result = this.db.prepare('INSERT OR IGNORE INTO computer_lifecycle (id, token) VALUES (?, ?)').run(id, token);
    if (Number(result.changes) !== 1) fail('computer_transition');
    return token;
  }
  private releaseLifecycle(id: string, token: string): void {
    const result = this.db.prepare('DELETE FROM computer_lifecycle WHERE id = ? AND token = ?').run(id, token);
    if (Number(result.changes) !== 1) fail('computer_transition');
  }
  private save(row: Row, state: ComputerState, expires = row.expires): void { this.update.run(state, expires, row.id, this.options.owner); }
  /** Pauses (`paused`) or unpauses (`ready`) the container; a no-op when it is already on that side. */
  private async toggle(id: string, want: 'paused' | 'ready'): Promise<void> {
    const row = this.row(id);
    if (row.state === 'human' || row.state === 'graphical') fail('computer_human_control');
    if (row.state === 'transition' || row.state === 'removing') fail('computer_transition');
    if (row.state === want) return;
    this.db.exec('BEGIN IMMEDIATE');
    let token: string;
    try {
      token = this.reserveLifecycle(id);
      const changed = this.db.prepare('UPDATE computers SET state = ? WHERE id = ? AND owner = ? AND state = ?').run('transition', id, this.options.owner, row.state);
      if (Number(changed.changes) !== 1) fail('computer_transition');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const freeze = want === 'paused';
    if ((await this.docker([freeze ? 'pause' : 'unpause', row.container])).code !== 0) fail(freeze ? 'computer_pause_failed' : 'computer_resume_failed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const committed = this.db.prepare('UPDATE computers SET state = ? WHERE id = ? AND owner = ? AND state = ? AND EXISTS (SELECT 1 FROM computer_lifecycle WHERE id = ? AND token = ?)').run(want, id, this.options.owner, 'transition', id, token);
      if (Number(committed.changes) !== 1) fail('computer_transition');
      this.releaseLifecycle(id, token);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
    const row: Row = { id: `cmp_${hash}`, profile: profileId, agent: agentId, container: `optchat-computer-${hash}`, state: 'transition', expires: this.now() + this.options.ttlMs };
    this.db.exec('BEGIN IMMEDIATE');
    let token: string;
    try {
      if (this.db.prepare('SELECT token FROM computer_owner_cleanup WHERE owner = ?').get(this.options.owner)) fail('computer_cleanup_active');
      token = this.reserveLifecycle(row.id);
      const existing = this.db.prepare('SELECT state FROM computers WHERE id = ? AND owner = ?').get(row.id, this.options.owner) as { state: ComputerState } | undefined;
      if (existing && existing.state !== 'ready') fail('computer_transition');
      if (existing) {
        this.db.prepare('UPDATE computers SET state = ?, expires = ? WHERE id = ? AND owner = ?').run('transition', row.expires, row.id, this.options.owner);
      } else {
        this.db.prepare('INSERT INTO computers (id, owner, profile, agent, container, state, expires) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, this.options.owner, row.profile, row.agent, row.container, row.state, row.expires);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    await this.ensureContainer(row);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const completed = this.db.prepare('UPDATE computers SET state = ? WHERE id = ? AND owner = ? AND state = ? AND EXISTS (SELECT 1 FROM computer_lifecycle WHERE id = ? AND token = ?)').run('ready', row.id, this.options.owner, 'transition', row.id, token);
      if (Number(completed.changes) !== 1) fail('computer_transition');
      this.releaseLifecycle(row.id, token);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  /** Trusted transports hold a lease until their container process has definitely exited. */
  beginOperation(id: string, destination?: string): { computer: Computer; finish: () => void } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.usable(id, destination);
      const token = randomUUID();
      this.db.prepare('INSERT INTO computer_operations (token, id) VALUES (?, ?)').run(token, id);
      this.db.exec('COMMIT');
      return { computer: this.view(row), finish: () => { this.db.prepare('DELETE FROM computer_operations WHERE token = ?').run(token); } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private usable(id: string, destination?: string): Row {
    const row = this.row(id);
    if (destination !== undefined && destination !== row.container) fail('computer_destination_mismatch');
    if (row.state === 'human' || row.state === 'graphical') fail('computer_human_control');
    if (row.state === 'transition' || row.state === 'removing') fail('computer_transition');
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
    const timeoutMs = boundedInteger(options.timeoutMs, 30_000, 1_000, 10 * 60_000);
    const lease = this.beginOperation(id, options.destination);
    const row = lease.computer;
    let completed = false;
    try {
      this.db.prepare('UPDATE computers SET expires = ? WHERE id = ?').run(this.now() + this.options.ttlMs, id);
      // `timeout -s KILL` ends the process inside the container too; killing only the CLI would leave it running.
      const result = await this.docker(['exec', '--user', '1000:1000', '--workdir', '/work', row.container, 'timeout', '-s', 'KILL', String(Math.ceil(timeoutMs / 1000)), ...argv], { timeoutMs: timeoutMs + 10_000 });
      const stdout = clip(result.stdout); const stderr = clip(result.stderr);
      completed = !result.uncertain;
      return { code: result.code, stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated };
    } finally { if (completed) lease.finish(); }
  }

  /** Immutable network-none target for the trusted STDIO broker; never a generic network attachment. */
  async isolatedTarget(id: string): Promise<string> {
    const row = this.usable(id);
    const result = await this.docker(['inspect', '--type', 'container', '--format', '{{json .}}', row.container]);
    if (result.code !== 0) fail('computer_inspection_failed');
    const info = JSON.parse(result.stdout);
    if (info.Config?.Labels?.[OWNER_LABEL] !== this.options.owner || info.HostConfig?.NetworkMode !== 'none' || info.Mounts?.length !== 0 || info.HostConfig?.ReadonlyRootfs !== true || !/^[a-f0-9]{64}$/.test(info.Id ?? '')) fail('computer_isolation_mismatch');
    this.usable(id, row.container);
    return info.Id;
  }

  /** Read-only view of the workspace listing, refused while a human holds control. */
  async capture(id: string): Promise<string> {
    const lease = this.beginOperation(id);
    const row = lease.computer;
    let completed = false;
    try {
      const result = await this.docker(['exec', '--user', '1000:1000', row.container, 'ls', '-la', '/work']);
      completed = !result.uncertain;
      if (result.code !== 0) fail('computer_capture_failed');
      return clip(result.stdout).text;
    } finally { if (completed) lease.finish(); }
  }

  /** Freezes every process in the computer. Anyone may pause; resuming needs the operator. */
  async pause(id: string): Promise<void> { return this.toggle(id, 'paused'); }
  async resume(id: string, authority: object): Promise<void> {
    this.authorize(authority);
    if (['human', 'graphical'].includes(this.row(id).state)) fail('computer_human_control');
    return this.toggle(id, 'ready');
  }

  /**
   * The operator takes the computer (login, 2FA). From now on agent exec and capture are refused until `handBack`.
   * Returns the argv for the operator's own terminal; nothing typed there passes through the agent or its transcript.
   */
  async takeover(id: string, authority: object): Promise<{ argv: string[] }> {
    this.authorize(authority);
    this.db.exec('BEGIN IMMEDIATE');
    let row: Row, token: string;
    try {
      row = this.row(id);
      if (row.state === 'human' || row.state === 'graphical') fail('computer_human_control');
      if (row.state === 'transition' || row.state === 'removing') fail('computer_transition');
      const active = this.db.prepare('SELECT token FROM computer_operations WHERE id = ? LIMIT 1').get(id);
      if (active) fail('computer_operations_active');
      token = this.reserveLifecycle(id);
      this.save(row, 'human');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (row.state === 'paused' && (await this.docker(['unpause', row.container])).code !== 0) fail('computer_resume_failed');
    this.releaseLifecycle(id, token);
    return { argv: ['docker', 'exec', '--interactive', '--tty', '--user', '1000:1000', '--workdir', '/work', '--env', 'HISTFILE=/dev/null', row.container, 'sh'] };
  }
  handBack(id: string, authority: object): void {
    this.authorize(authority);
    const row = this.row(id);
    if (row.state !== 'human') fail('computer_not_in_takeover');
    if (this.db.prepare('SELECT token FROM computer_lifecycle WHERE id = ?').get(id)) fail('computer_transition');
    this.save(row, 'ready', this.now() + this.options.ttlMs);
  }

  /** Reserves ownership before starting a fresh, human-only container. */
  async beginGraphical(id: string, authority: object): Promise<{ generation: string; target: string }> {
    this.authorize(authority);
    const generation = randomUUID();
    const name = `optchat-human-${generation}`;
    this.db.exec('BEGIN IMMEDIATE');
    let row: Row;
    try {
      row = this.row(id);
      if (row.state !== 'ready') fail('computer_not_ready');
      if (this.db.prepare('SELECT token FROM computer_operations WHERE id = ? LIMIT 1').get(id)) fail('computer_operations_active');
      this.db.prepare('INSERT INTO computer_graphical (id, generation, container, phase) VALUES (?, ?, ?, ?)').run(id, generation, name, 'uncertain');
      this.save(row, 'graphical');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const run = await this.docker(this.runArgs({ ...row, container: name }), { timeoutMs: 60_000 });
    if (run.uncertain || (run.code === 0 && !/^[a-f0-9]{64}$/.test(run.stdout.trim()))) fail('computer_graphical_start_uncertain');
    this.db.prepare('UPDATE computer_graphical SET phase = ?, target = ? WHERE id = ? AND generation = ?').run('settled', run.code === 0 ? run.stdout.trim() : null, id, generation);
    if (run.code !== 0) {
      try { await this.endGraphical(id, generation, authority); }
      catch (cleanup) { throw new Error('computer_graphical_cleanup_uncertain', { cause: cleanup }); }
      fail('computer_graphical_start_failed');
    }
    return { generation, target: run.stdout.trim() };
  }

  /** Removes only the generation's unique human container before restoring agent access. */
  async endGraphical(id: string, generation: string, authority: object): Promise<void> {
    this.authorize(authority);
    this.db.exec('BEGIN IMMEDIATE');
    let entry: { generation: string; container: string; phase: string; target: string | null }, token: string;
    try {
      const found = this.db.prepare('SELECT generation, container, phase, target FROM computer_graphical WHERE id = ?').get(id) as typeof entry | undefined;
      if (!found || found.generation !== generation || this.row(id).state !== 'graphical') fail('computer_graphical_stale');
      if (found.phase !== 'settled') fail('computer_graphical_start_uncertain');
      entry = found;
      token = this.reserveLifecycle(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const ownerRow = this.row(id);
    const result = await removeComputer(this.docker, this.options.owner, entry.container, true, entry.target ?? undefined, entry.target ? { profile: ownerRow.profile, agent: ownerRow.agent } : undefined);
    if (result === 'foreign' || result === 'failed') fail('computer_graphical_cleanup_uncertain');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.db.prepare('DELETE FROM computer_graphical WHERE id = ? AND generation = ? AND EXISTS (SELECT 1 FROM computer_lifecycle WHERE id = ? AND token = ?)').run(id, generation, id, token);
      if (Number(removed.changes) !== 1 || this.row(id).state !== 'graphical') fail('computer_graphical_stale');
      this.save(this.row(id), 'ready', this.now() + this.options.ttlMs);
      this.releaseLifecycle(id, token);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Read-only recovery inventory; an absent container never proves an uncertain Docker request has settled. */
  async inspectRecovery(authority: object): Promise<{ cleanupActive: boolean; computers: Array<{ computer: Computer; generation?: string; phase?: string; target?: string; inspection: 'verified' | 'unavailable' }> }> {
    this.authorize(authority);
    const cleanupActive = !!this.db.prepare('SELECT token FROM computer_owner_cleanup WHERE owner = ?').get(this.options.owner);
    const computers = [] as Array<{ computer: Computer; generation?: string; phase?: string; target?: string; inspection: 'verified' | 'unavailable' }>;
    for (const computer of this.list().filter(value => ['transition', 'removing', 'graphical'].includes(value.state))) {
      const graphical = this.db.prepare('SELECT generation, container, phase FROM computer_graphical WHERE id = ?').get(computer.id) as { generation: string; container: string; phase: string } | undefined;
      const result = await this.docker(['inspect', '--type', 'container', '--format', '{{json .}}', graphical?.container ?? computer.container]);
      let target: string | undefined;
      if (result.code === 0) {
        const info = JSON.parse(result.stdout);
        if (info.Config?.Labels?.[OWNER_LABEL] === this.options.owner && /^[a-f0-9]{64}$/.test(info.Id ?? '')) target = info.Id;
      }
      computers.push({ computer, generation: graphical?.generation, phase: graphical?.phase, target, inspection: target ? 'verified' : 'unavailable' });
    }
    return { cleanupActive, computers };
  }

  /** An explicit recovery can remove a settled generation only after matching its immutable identity. */
  async reconcileGraphical(id: string, generation: string, target: string, authority: object): Promise<void> {
    this.authorize(authority);
    const entry = this.db.prepare('SELECT generation, phase, target FROM computer_graphical WHERE id = ?').get(id) as { generation: string; phase: string; target: string | null } | undefined;
    if (!entry || entry.generation !== generation || entry.phase !== 'settled' || entry.target !== target || !/^[a-f0-9]{64}$/.test(target)) fail('computer_graphical_reconcile_refused');
    const inventory = await this.inspectRecovery(authority);
    if (!inventory.computers.some(item => item.computer.id === id && item.generation === generation && item.target === target && item.inspection === 'verified')) fail('computer_graphical_reconcile_refused');
    await this.endGraphical(id, generation, authority);
  }

  /** Removes one own computer after confirming its container still carries this owner's label. */
  async destroy(id: string): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    let row: Row, token: string;
    try {
      row = this.row(id);
      if (row.state === 'graphical' || row.state === 'transition' || row.state === 'removing') fail('computer_transition');
      token = this.reserveLifecycle(id);
      const reserved = this.db.prepare('UPDATE computers SET state = ? WHERE id = ? AND owner = ? AND state = ?').run('removing', id, this.options.owner, row.state);
      if (Number(reserved.changes) !== 1) fail('computer_transition');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const result = await removeComputer(this.docker, this.options.owner, row.container, true);
    if (result === 'foreign') fail('computer_conflict');
    if (result === 'failed') fail('computer_remove_failed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const deleted = this.db.prepare('DELETE FROM computers WHERE id = ? AND owner = ? AND state = ? AND EXISTS (SELECT 1 FROM computer_lifecycle WHERE id = ? AND token = ?)').run(id, this.options.owner, 'removing', id, token);
      if (Number(deleted.changes) !== 1) fail('computer_transition');
      this.db.prepare('DELETE FROM computer_operations WHERE id = ?').run(id);
      this.releaseLifecycle(id, token);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Destroys expired computers. One held by a human is kept until handed back. */
  async sweep(): Promise<string[]> {
    const expired = this.db.prepare("SELECT id FROM computers WHERE owner = ? AND expires <= ? AND state IN ('ready', 'paused')").all(this.options.owner, this.now()) as { id: string }[];
    for (const { id } of expired) await this.destroy(id);
    return expired.map(row => row.id);
  }

  /** Removes every container labelled with this owner (including ones a crashed process left behind) and their rows. */
  async cleanup(): Promise<number> {
    this.db.exec('BEGIN IMMEDIATE');
    let containers: string[], ownerToken: string;
    const reservations = new Map<string, { id: string; token: string }>();
    try {
      if (this.db.prepare('SELECT token FROM computer_owner_cleanup WHERE owner = ?').get(this.options.owner)) fail('computer_cleanup_active');
      const rows = this.list();
      if (rows.some(row => row.state === 'graphical' || row.state === 'transition' || row.state === 'removing')) fail('computer_transition');
      ownerToken = randomUUID();
      this.db.prepare('INSERT INTO computer_owner_cleanup (owner, token) VALUES (?, ?)').run(this.options.owner, ownerToken);
      for (const row of rows) reservations.set(row.container, { id: row.id, token: this.reserveLifecycle(row.id) });
      containers = rows.map(row => row.container);
      this.db.prepare("UPDATE computers SET state = 'removing' WHERE owner = ?").run(this.options.owner);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const result = await cleanupComputers(this.docker, this.options.owner, containers);
    if (!result) fail('computer_cleanup_failed: listing');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const name of result.cleared) {
        const reservation = reservations.get(name);
        if (!reservation) continue;
        const deleted = this.db.prepare('DELETE FROM computers WHERE owner = ? AND id = ? AND container = ? AND state = ? AND EXISTS (SELECT 1 FROM computer_lifecycle WHERE id = ? AND token = ?)').run(this.options.owner, reservation.id, name, 'removing', reservation.id, reservation.token);
        if (Number(deleted.changes) !== 1) fail('computer_transition');
        this.db.prepare('DELETE FROM computer_operations WHERE id = ?').run(reservation.id);
        this.releaseLifecycle(reservation.id, reservation.token);
      }
      if (!result.failures) {
        const released = this.db.prepare('DELETE FROM computer_owner_cleanup WHERE owner = ? AND token = ?').run(this.options.owner, ownerToken);
        if (Number(released.changes) !== 1) fail('computer_cleanup_active');
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (result.failures) fail(`computer_cleanup_failed: ${result.failures} container(s) require inspection`);
    return result.removed;
  }

  close(): void { this.db.close(); }
}

export function createComputers(options: ComputerOptions): ComputerManager { return new ComputerManager(options); }
