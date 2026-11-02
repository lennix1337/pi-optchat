/**
 * The environment port: everything the service does on this machine that is a process (Docker, the Windows toast, the
 * DPAPI key wrap). The service asks for a named action with typed fields; this table decides the one process that
 * action may start, with its arguments, environment, input and timeout. Nothing else reaches a process: no shell, no
 * argv from the caller beyond the validated fields, and an unknown action or field is refused before anything runs.
 *
 * Pure: it builds plans and validates them. The local adapter (local.ts) is the only code that starts a process.
 */

export type RunRequest =
  | { action: 'docker'; args: readonly string[]; timeoutMs?: number }
  | { action: 'toast'; text: string }
  | { action: 'dpapi'; op: 'protect' | 'unprotect'; data: string };
export type OpenRequest = { action: 'docker_stream'; container: string; program: 'https-relay' | 'socat-viewer' };
export type RunResult = { code: number; stdout: string; stderr: string; uncertain: boolean };

/** A refused request names a code, never the caller's values. */
export class EnvironmentRefused extends Error {
  constructor(code: string) { super(code); this.name = 'EnvironmentRefused'; }
}

export type Plan = { file: string; args: string[]; env?: Record<string, string>; stdin?: string; timeoutMs: number };

const MAX_ARGS = 256, MAX_ARG = 4096, MAX_TEXT = 4000, MAX_DATA = 1 << 20;
const DEFAULT_DOCKER_TIMEOUT_MS = 30_000, MAX_DOCKER_TIMEOUT_MS = 120_000;

/** Docker subcommands the computer manager uses. `image` is limited to `image inspect` below. */
const DOCKER_SUBCOMMANDS: ReadonlySet<string> = new Set(['info', 'image', 'inspect', 'ps', 'pause', 'unpause', 'run', 'start', 'exec', 'rm']);
/** Flags that would give a container host files, devices, privileges or the host's namespaces, refused whatever the subcommand. */
const DOCKER_REFUSED_FLAGS: ReadonlySet<string> = new Set(['--privileged', '--cap-add', '--device', '--volume', '-v', '--mount', '--pid', '--userns']);
/** Networks that join the host's or another container's namespace; the manager runs its computers with `--network none`. */
const SHARED_NETWORK = /^(host|container:.*)$/;

const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Windows PowerShell 5.1 with the toast script; the text travels in the environment, not on the command line.
const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode('OptChat')) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:OPTCHAT_TOAST_TEXT)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;
const TOAST_ENCODED = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');

// Data travels on stdin, never argv: DPAPI (CurrentUser) only unwraps for this Windows account on this machine.
const DPAPI_SCRIPT = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$i=[Console]::In.ReadToEnd().Trim().Split(' ')
$d=[Convert]::FromBase64String($i[1])
$s=[Security.Cryptography.DataProtectionScope]::CurrentUser
$o=if($i[0] -eq 'protect'){[Security.Cryptography.ProtectedData]::Protect($d,$null,$s)}else{[Security.Cryptography.ProtectedData]::Unprotect($d,$null,$s)}
[Console]::Out.Write([Convert]::ToBase64String($o))`;
const DPAPI_ENCODED = Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64');
/** A PowerShell start can take 7-8 s on a loaded runner and over 15 s at its tail; a stuck one is cut off past that. */
const DPAPI_TIMEOUT_MS = 60_000;

/** The exact docker argv for each stream program; the caller supplies only the container. */
const STREAM_ARGS: Record<OpenRequest['program'], (container: string) => string[]> = {
  'https-relay': container => ['exec', '--interactive', '--user', '1000:1000', '--workdir', '/work', container, 'timeout', '-s', 'KILL', '150', 'node', '/opt/optchat/https-relay.mjs'],
  'socat-viewer': container => ['exec', '-i', container, 'socat', '-', 'TCP:127.0.0.1:6088'],
};

function refused(code: string): never { throw new EnvironmentRefused(code); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function noNul(value: string): boolean { return !value.includes('\0'); }

function checkDockerArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARGS) refused('invalid_docker_args');
  const args = value as unknown[];
  if (!args.every((arg): arg is string => typeof arg === 'string' && arg.length <= MAX_ARG && noNul(arg))) refused('invalid_docker_args');
  const argv = args as string[];
  if (!DOCKER_SUBCOMMANDS.has(argv[0]!)) refused('docker_subcommand_refused');
  if (argv[0] === 'image' && argv[1] !== 'inspect') refused('docker_subcommand_refused');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (DOCKER_REFUSED_FLAGS.has(flag)) refused('docker_flag_refused');
    if (flag === '--network' || flag === '--net') {
      const network = eq < 0 ? argv[i + 1] : arg.slice(eq + 1);
      if (network !== undefined && SHARED_NETWORK.test(network)) refused('docker_flag_refused');
    }
  }
  return argv;
}

function timeout(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) refused('invalid_timeout');
  return value as number;
}

/** The allow-list of run actions: each validated request maps to one fixed process. */
const RUN_ACTIONS = new Map<string, (request: Record<string, unknown>) => Plan>([
  ['docker', request => ({ file: 'docker', args: checkDockerArgs(request.args), timeoutMs: timeout(request.timeoutMs, DEFAULT_DOCKER_TIMEOUT_MS, MAX_DOCKER_TIMEOUT_MS) })],
  ['toast', request => {
    if (typeof request.text !== 'string' || request.text.length > MAX_TEXT || !noNul(request.text)) refused('invalid_toast_text');
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', TOAST_ENCODED], env: { OPTCHAT_TOAST_TEXT: request.text }, timeoutMs: 20_000 };
  }],
  ['dpapi', request => {
    if (request.op !== 'protect' && request.op !== 'unprotect') refused('invalid_dpapi_op');
    if (typeof request.data !== 'string' || request.data.length > MAX_DATA || !BASE64.test(request.data)) refused('invalid_dpapi_data');
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', DPAPI_ENCODED], stdin: `${request.op} ${request.data}`, timeoutMs: DPAPI_TIMEOUT_MS };
  }],
]);

/** The allow-list of stream actions: a long-lived child whose stdio the caller pipes. */
const STREAM_ACTIONS = new Map<string, (request: Record<string, unknown>) => Plan>([
  ['docker_stream', request => {
    if (typeof request.container !== 'string' || !CONTAINER.test(request.container)) refused('invalid_container');
    if (typeof request.program !== 'string' || !Object.hasOwn(STREAM_ARGS, request.program)) refused('invalid_program');
    const program = request.program as OpenRequest['program'];
    return { file: 'docker', args: STREAM_ARGS[program](request.container as string), timeoutMs: 0 };
  }],
]);

function actionOf(value: unknown, table: Map<string, unknown>): Record<string, unknown> & { action: string } {
  if (!isRecord(value) || typeof value.action !== 'string' || !table.has(value.action)) refused('unknown_action');
  return value as Record<string, unknown> & { action: string };
}

/** Validates a run request (its shape may come from an untrusted caller) and returns the process it allows. */
export function planRun(value: unknown): Plan {
  const request = actionOf(value, RUN_ACTIONS);
  return RUN_ACTIONS.get(request.action)!(request);
}

/** Validates a stream request and returns the process it allows. */
export function planOpen(value: unknown): Plan {
  const request = actionOf(value, STREAM_ACTIONS);
  return STREAM_ACTIONS.get(request.action)!(request);
}

