/**
 * Effects that leave the operator's machine and cannot be taken back: a message reaching a third party (WhatsApp, SMS,
 * email), a write to a production HTTP API, and input on a consent, billing or account page in the browser. They are
 * read from the call's own words (curl/wget/Invoke-RestMethod arguments, mail commands, the browser tab's last known
 * page), never from the conversation. Not a sandbox: a script that hides its request passes; the classes are a
 * guardrail against the accidents the operator already lived through (a real WhatsApp sent, a consent clicked).
 */

/** The operator's production web hosts: a write there changes live data. Subdomains count. */
export const PRODUCTION_HOSTS = ['dentai.com.br', 'usdentai.com'];
/** Messaging and email APIs: any request that sends through them reaches a person. */
const MESSAGE_HOSTS = ['graph.facebook.com', 'api.whatsapp.com', 'whatsapp.net', 'api.twilio.com', 'api.sendgrid.com', 'api.mailgun.net',
  'api.resend.com', 'api.postmarkapp.com', 'api.brevo.com', 'api.sendinblue.com', 'z-api.io', 'api.telegram.org', 'api.zenvia.com',
  'gmail.googleapis.com', 'graph.microsoft.com'];
/** Pages where a click grants consent, changes an account or spends money. Host, optionally with a path prefix. */
const SENSITIVE_PAGES = ['accounts.google.com', 'myaccount.google.com', 'pay.google.com', 'payments.google.com', 'console.cloud.google.com',
  'admin.google.com', 'login.microsoftonline.com', 'appleid.apple.com', 'github.com/login/oauth', 'github.com/settings', 'github.com/apps',
  'stripe.com', 'paypal.com', 'business.facebook.com', 'checkout.', 'billing.'];

const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
export const productionHost = (host: string) => PRODUCTION_HOSTS.some(domain => within(host, domain));
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

/** Whether an HTTP client's arguments send data or use a writing method. */
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
  // httpie/xh: `http POST url`, or `key=value` / `key:=json` data items.
  return /^(?:post|put|patch|delete)$/i.test(args[0] ?? '') || args.some(arg => /^[\w.-]+:?=/.test(unquote(arg)));
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
  const write = writes(lower, args);
  for (const url of urls) {
    const host = url.hostname.toLowerCase();
    // Telegram sends with a GET too: /bot<token>/sendMessage.
    if (messageHost(host) && (write || /\/send\w*$/i.test(url.pathname))) effects.push({ action: 'message', targets: [host] });
    else if (write && productionHost(host)) effects.push({ action: 'production-write', targets: [`https:${host}`] });
  }
  return effects;
}

// ---- The browser: which page each owned tab shows, as its results report it. ----
const tabPages = new Map<string, string>();
const MAX_TABS = 64;

function remember(tab: string, url: string) {
  tabPages.delete(tab);
  tabPages.set(tab, url);
  while (tabPages.size > MAX_TABS) tabPages.delete(tabPages.keys().next().value!);
}

/** Records the page a browser_harness call reports or navigates to (open/navigate input, `url` in any result). */
export function observeBrowser(input: unknown, resultText: string | undefined) {
  const args = (input && typeof input === 'object' ? input : {}) as { action?: unknown; tab?: unknown; url?: unknown };
  let tab = typeof args.tab === 'string' ? args.tab : undefined;
  let url: string | undefined;
  if (resultText) {
    const reported = /"tab"\s*:\s*"([^"]+)"/.exec(resultText)?.[1];
    tab ??= reported;
    url = /"url"\s*:\s*"([^"]+)"/.exec(resultText)?.[1];
  }
  if (!url && (args.action === 'navigate' || args.action === 'open') && typeof args.url === 'string') url = args.url;
  if (tab && url) remember(tab, url);
  if (tab && args.action === 'close') tabPages.delete(tab);
}

/** The consent effect of a browser call: input (click, type, evaluate) on a tab last seen on a sensitive page. */
export function browserConsentEffect(input: unknown): { action: 'consent'; targets: string[] } | undefined {
  const args = (input && typeof input === 'object' ? input : {}) as { action?: unknown; tab?: unknown; expression?: unknown };
  // Looking at a page (open, navigate, inspect, screenshot, a reading script) is not consenting.
  const acts = args.action === 'click' || args.action === 'type'
    || (args.action === 'evaluate' && typeof args.expression === 'string' && /\.(?:click|submit|requestSubmit)\s*\(|dispatchEvent|\.(?:value|checked)\s*=[^=]/.test(args.expression));
  if (!acts) return undefined;
  const page = typeof args.tab === 'string' ? tabPages.get(args.tab) : undefined;
  return page && sensitivePage(page) ? { action: 'consent', targets: [parse(page)!.hostname.toLowerCase()] } : undefined;
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
