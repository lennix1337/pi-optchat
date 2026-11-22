
import { AsyncLocalStorage } from 'node:async_hooks';

const hostScope = new AsyncLocalStorage<readonly string[]>();
/** A missing or empty host list conservatively protects every destination. */
export const withProductionHosts = <T>(hosts: readonly string[] | undefined, fn: () => T): T => hostScope.run(hosts ?? [], fn);

const MESSAGE_HOSTS = ['graph.facebook.com', 'api.whatsapp.com', 'whatsapp.net', 'api.twilio.com', 'api.sendgrid.com', 'api.mailgun.net',
  'api.resend.com', 'api.postmarkapp.com', 'api.brevo.com', 'api.sendinblue.com', 'z-api.io', 'api.telegram.org', 'api.zenvia.com',
  'gmail.googleapis.com', 'graph.microsoft.com'];

const SENSITIVE_PAGES = ['accounts.google.com', 'myaccount.google.com', 'pay.google.com', 'payments.google.com', 'console.cloud.google.com',
  'admin.google.com', 'login.microsoftonline.com', 'appleid.apple.com', 'github.com/login/oauth', 'github.com/settings', 'github.com/apps',
  'stripe.com', 'paypal.com', 'business.facebook.com', 'checkout.', 'billing.'];

const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
export const productionHost = (host: string) => {
  const hosts = hostScope.getStore();
  return !hosts?.length || hosts.some(domain => within(host.toLowerCase(), domain));
};
const messageHost = (host: string) => MESSAGE_HOSTS.some(domain => within(host, domain));

function parse(url: string): URL | undefined {
  try { return new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `https://${url}`); } catch { return undefined; }
}

/** Whether a page is one where input can grant consent, change an account or pay. */
export function sensitivePage(url: string | undefined) {
  const page = url && parse(url);
  if (!page || !/^https?:$/.test(page.protocol)) return false;
  const host = page.hostname.toLowerCase(), path = page.pathname.toLowerCase();
  return SENSITIVE_PAGES.some(entry => {
    if (entry.endsWith('.')) return host.startsWith(entry);
    const [domain, ...rest] = entry.split('/');
    return within(host, domain!) && (!rest.length || path.startsWith(`/${rest.join('/')}`));
  });
}

const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');
const HTTP_CLIENTS = /^(?:curl|wget|invoke-restmethod|irm|invoke-webrequest|iwr|http|https|xh)$/;
const MAIL_COMMANDS = /^(?:send-mailmessage|sendmail|swaks|msmtp|mutt|mailx)$/;
const READ_METHODS = /^(?:get|head|options)$/i;


function writes(lower: string, args: string[]) {
  const method = (flag: RegExp) => {
    const at = args.findIndex(arg => flag.test(arg));
    if (at < 0) return undefined;
    const inline = /=(.+)$/.exec(args[at]!)?.[1];
    return unquote(inline ?? args[at + 1] ?? '');
  };
  if (lower === 'curl') {
    const verb = method(/^(?:-X|--request(?:=.*)?)$|^-X\w+$/) ?? /^-X(\w+)$/.exec(args.find(arg => /^-X\w+$/.test(arg)) ?? '')?.[1];
    return (verb !== undefined && !READ_METHODS.test(verb)) || args.some(arg => /^(?:-d|-F|-T|--data(?:-\w+)?|--json|--form(?:-string)?|--upload-file)(?:=|$)/.test(arg) || /^-[dFT]./.test(arg));
  }
  if (lower === 'wget') return args.some(arg => /^--(?:post-data|post-file|body-data|body-file)(?:=|$)/.test(arg)) || /^(?!get|head)/i.test(method(/^--method(?:=.*)?$/) ?? 'get');
  if (/^(?:invoke-restmethod|irm|invoke-webrequest|iwr)$/.test(lower)) {
    const verb = method(/^-Method$/i);
    return (verb !== undefined && !READ_METHODS.test(verb)) || args.some(arg => /^-Body$/i.test(arg));
  }
  // external: httpie and xh data items such as key=value send a request body.
  return /^(?:post|put|patch|delete)$/i.test(args[0] ?? '') || args.some(arg => /^[\w.-]+:?=/.test(unquote(arg)));
}

const CREDENTIAL_FLAGS = /^(?:-u|--user|-b|--cookie|-E|--cert|--oauth2-bearer|-n|--netrc(?:-file)?|--http-user|--http-password|--password|--user|-a|--auth|-Credential|-WebSession|-Authentication|-Token|-Certificate)(?:=|$)/i;
const CREDENTIAL_HEADER = /\b(?:authorization|cookie|token|api[-_]?key|secret|signature|session|auth)\b/i;






function anonymousProbe(lower: string, args: string[]) {
  const words = args.map(unquote);
  const verb = words.find((_, i) => /^(?:-X|--request|-Method|--method)$/i.test(words[i - 1] ?? ''))
    ?? /^(?:-X|--request=|--method=)(\w+)$/i.exec(words.find(w => /^(?:-X\w+|--request=\w+|--method=\w+)$/i.test(w)) ?? '')?.[1];
  if (lower === 'http' || lower === 'https' || lower === 'xh') return false;
  if (!verb || !/^post$/i.test(verb)) return false;
  if (words.some(w => /^(?:-d|-F|-T|--data(?:-\w+)?|--json|--form(?:-string)?|--upload-file|--post-data|--post-file|--body-data|--body-file|-Body|-InFile)(?:=|$)/i.test(w) || /^-[dFT]./.test(w))) return false;
  if (words.some(w => CREDENTIAL_FLAGS.test(w) || /^-Headers$/i.test(w))) return false;
  return !words.some((w, i) => /^(?:-H|--header)$/i.test(words[i - 1] ?? '') && CREDENTIAL_HEADER.test(w.split(':')[0] ?? ''))
    && !words.some(w => /^--header=/i.test(w) && CREDENTIAL_HEADER.test(w.slice(9).split(':')[0] ?? ''));
}

export type ExternalEffect = { action: 'message' | 'production-write'; targets: string[] };

/** The external effects of one command (its words from the command word on). */
export function commandExternalEffects(w: string[]): ExternalEffect[] {
  const lower = unquote(w[0] ?? '').replace(/\.exe$/i, '').split(/[/\\]/).at(-1)!.toLowerCase();
  const args = w.slice(1);
  if (MAIL_COMMANDS.test(lower) || (lower === 'mail' && args.includes('-s'))) return [{ action: 'message', targets: ['email'] }];
  if (!HTTP_CLIENTS.test(lower)) return [];
  const urls = args.map(unquote).filter(arg => /^https?:\/\//i.test(arg) || (/^(?:http|https|xh)$/.test(lower) && /^[\w-]+(?:\.[\w-]+)+(?:[:/]|$)/.test(arg)))
    .flatMap(arg => { const url = parse(arg); return url ? [url] : []; });
  const effects: ExternalEffect[] = [];
  const write = writes(lower, args) && !anonymousProbe(lower, args);
  for (const url of urls) {
    const host = url.hostname.toLowerCase();
    // external: Telegram sendMessage can send messages with GET.
    if (messageHost(host) && (write || /\/send\w*$/i.test(url.pathname))) effects.push({ action: 'message', targets: [host] });
    else if (write && productionHost(host)) effects.push({ action: 'production-write', targets: [`https:${host}`] });
  }
  return effects;
}



const PAGE_INPUT = /\.(?:click|submit|requestSubmit)\s*\(|dispatchEvent|\.(?:value|checked)\s*=[^=]|\bInput\.(?:dispatch\w+|insertText)\b/;
const WRITE_VERB = /^(?:post|put|patch|delete)$/i;
const PAGE_CALLS = [

  { re: /\bfetch\(\s*(['"`])([^'"`]+)\1\s*,\s*\{([^}]*)\}/g, url: 2, verb: (m: RegExpMatchArray) => /\bmethod\s*:\s*['"`](\w+)['"`]/.exec(m[3]!)?.[1] },

  { re: /\.open\(\s*(['"`])(\w+)\1\s*,\s*(['"`])([^'"`]+)\3/g, url: 4, verb: (m: RegExpMatchArray) => m[2] },

  { re: /\baxios\.(post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/gi, url: 3, verb: (m: RegExpMatchArray) => m[1] },
];

/** The production writes and messages a page script makes; a relative URL resolves against `page`, the tab's address. */
export function pageScriptEffects(script: string, page?: string): ExternalEffect[] {
  const text = script.replace(/\\(["'`])/g, '$1');
  const effects: ExternalEffect[] = [];
  for (const call of PAGE_CALLS) for (const m of text.matchAll(call.re)) {
    if (!WRITE_VERB.test(call.verb(m) ?? '')) continue;
    let url: URL | undefined;
    try { url = new URL(m[call.url]!, page); } catch { continue; }
    const host = url.hostname.toLowerCase();
    if (messageHost(host)) effects.push({ action: 'message', targets: [host] });
    else if (productionHost(host)) effects.push({ action: 'production-write', targets: [`https:${host}`] });
  }
  return effects;
}


const tabPages = new Map<string, string>();

// external: browser_harness exec runs Python cells against the owned tab.
const EXEC_INPUT = /(?<![.\w])(?:click|press|upload)\s*\(|(?<![.\w])type\s*\(\s*[^,()]+,|(?<![.\w])dialog\s*\(\s*(?:accept\s*=\s*)?True\b/;
const EXEC_GOTO = /(?<![.\w])goto\s*\(\s*(?:url\s*=\s*)?(['"])([^'"\\]+)\1/g;
const execCode = (args: { action?: unknown; code?: unknown }) => args.action === 'exec' && typeof args.code === 'string' ? args.code : undefined;
const gotoPages = (code: string) => [...code.matchAll(EXEC_GOTO)].map(m => m[2]!);
const MAX_TABS = 64;

function remember(tab: string, url: string) {
  tabPages.delete(tab);
  tabPages.set(tab, url);
  while (tabPages.size > MAX_TABS) tabPages.delete(tabPages.keys().next().value!);
}

function resultHeader(resultText: string | undefined): { tab?: string; url?: string } {
  try {
    const header: unknown = JSON.parse(resultText?.split('\n', 1)[0] ?? '');
    if (!header || typeof header !== 'object') return {};
    const { tab, url } = header as { tab?: unknown; url?: unknown };
    return { tab: typeof tab === 'string' ? tab : undefined, url: typeof url === 'string' ? url : undefined };
  } catch { return {}; }
}

/** Records the page a browser_harness call reports or navigates to (open/navigate input, `url` in any result). */
export function observeBrowser(input: unknown, resultText: string | undefined) {
  const args = (input && typeof input === 'object' ? input : {}) as { action?: unknown; tab?: unknown; url?: unknown; code?: unknown };
  let tab = typeof args.tab === 'string' ? args.tab : undefined;
  let url: string | undefined;
  if (resultText) {
    const reported = /"tab"\s*:\s*"([^"]+)"/.exec(resultText)?.[1];
    tab ??= reported;
    url = /"url"\s*:\s*"([^"]+)"/.exec(resultText)?.[1];
  }
  if (args.action === 'exec' || args.action === 'state') {
    // external: browser_harness identifies the tab page in the first-line JSON header.
    const header = resultHeader(resultText);
    tab = typeof args.tab === 'string' ? args.tab : header.tab;
    url = header.url;
  }
  const code = execCode(args);
  if (!url && code !== undefined) url = gotoPages(code).at(-1);
  if (!url && (args.action === 'navigate' || args.action === 'open') && typeof args.url === 'string') url = args.url;
  if (tab && url) remember(tab, url);
  if (tab && args.action === 'close') tabPages.delete(tab);
}

/**
 * The consent effect of a browser call: input (click, type, evaluate, an exec cell's input helpers) on a tab last seen
 * on a sensitive page, or that the cell itself takes there with a goto.
 */
export function browserConsentEffect(input: unknown): { action: 'consent'; targets: string[] } | undefined {
  const args = (input && typeof input === 'object' ? input : {}) as { action?: unknown; tab?: unknown; expression?: unknown; code?: unknown };
  const code = execCode(args);

  const acts = args.action === 'click' || args.action === 'type'
    || (args.action === 'evaluate' && typeof args.expression === 'string' && PAGE_INPUT.test(args.expression))
    || (code !== undefined && (EXEC_INPUT.test(code) || PAGE_INPUT.test(code)));
  if (!acts) return undefined;
  const known = typeof args.tab === 'string' ? tabPages.get(args.tab) : undefined;
  const page = [known, ...(code === undefined ? [] : gotoPages(code))].find(candidate => candidate && sensitivePage(candidate));
  return page ? { action: 'consent', targets: [parse(page)!.hostname.toLowerCase()] } : undefined;
}

/** The production writes and messages of a browser evaluate or exec cell, its relative URLs read against the tab's page (a goto in the cell moves it). */
export function browserScriptEffects(input: unknown): ExternalEffect[] {
  const args = (input && typeof input === 'object' ? input : {}) as { action?: unknown; tab?: unknown; expression?: unknown; code?: unknown };
  const known = typeof args.tab === 'string' ? tabPages.get(args.tab) : undefined;
  const code = execCode(args);
  if (code !== undefined) return pageScriptEffects(code, gotoPages(code).at(-1) ?? known);
  if (args.action !== 'evaluate' || typeof args.expression !== 'string') return [];
  return pageScriptEffects(args.expression, known);
}


function tabPage(id: string) {
  const exact = tabPages.get(id);
  if (exact || id.length < 8) return exact;
  return [...tabPages].find(([tab]) => tab.length >= 8 && (tab.startsWith(id) || id.startsWith(tab)))?.[1];
}

/**
 * The production writes and messages of a script file run from the shell (06/11: a CDP script filled and submitted the
 * live example clinic form, a fake lead). Its fetch/XHR calls count like a page script's; its page input (a click, a
 * submit, a value set, CDP input) counts as a production write when the script names a production page, or is handed
 * a URL or an owned tab last seen on one.
 */
export function scriptFileEffects(source: string, args: string[]): ExternalEffect[] {
  const effects = pageScriptEffects(source);
  if (PAGE_INPUT.test(source)) {
    const pages = [...source.matchAll(/https?:\/\/[\w.-]+/gi)].map(m => m[0]);
    for (const arg of args.map(unquote)) pages.push(...(/^https?:\/\//i.test(arg) ? [arg] : []), ...(tabPage(arg) ? [tabPage(arg)!] : []));
    for (const page of pages) {
      const host = parse(page)?.hostname.toLowerCase();
      if (host && productionHost(host)) effects.push({ action: 'production-write', targets: [`https:${host}`] });
    }
  }
  const seen = new Set<string>();
  return effects.filter(effect => { const key = `${effect.action} ${effect.targets}`; return !seen.has(key) && !!seen.add(key); });
}

/** Test seam: forget every tab. */
export const forgetBrowserPages = () => tabPages.clear();

/** Keeps each owned tab's last known page from browser_harness results, for `browserConsentEffect`. */
export function registerBrowserPages(pi: { on(event: 'tool_result', handler: (event: { toolName: string; input: unknown; content: { type: string; text?: string }[] }) => void): void }) {
  pi.on('tool_result', event => {
    if (event.toolName !== 'browser_harness') return;
    observeBrowser(event.input, event.content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n'));
  });
}
