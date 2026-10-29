import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import type { Vault } from '../assistant/src/secrets/vault.ts';

const MAX_SECRET_BYTES = 8192;
const PASTE = /\u001b\[20[01]~/g;
const usage = 'Usage: /assistant-secret [list | add <origin> <action> | rotate <ref> | revoke <ref>]';

/**
 * Masked entry for one secret. Keystrokes stay in this component: nothing is echoed, sent to the model, written to the
 * session or copied. JavaScript strings cannot be wiped, so the typed characters live only until the dialog closes.
 */
export class SecretEntry implements Component {
  private chars: string[] = [];
  private bytes = 0;
  private closed = false;
  private readonly title: string;
  private readonly tui: Pick<TUI, 'requestRender'>;
  private readonly done: (value: Buffer | undefined) => void;
  constructor(title: string, tui: Pick<TUI, 'requestRender'>, done: (value: Buffer | undefined) => void) { this.title = title; this.tui = tui; this.done = done; }
  invalidate() {}
  render(width: number): string[] {
    const mask = '•'.repeat(Math.min(this.chars.length, 32)) + (this.chars.length > 32 ? '…' : '');
    return [this.title, `Secret: ${mask}`, 'Enter store · Esc cancel · Backspace delete · paste works. Not shown, not sent to the model, not saved in the session.']
      .map(line => truncateToWidth(line, Math.max(1, width)));
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.finish(undefined); return; }
    if (matchesKey(data, 'enter')) { this.finish(this.chars.length ? Buffer.from(this.chars.join(''), 'utf8') : undefined); return; }
    if (matchesKey(data, 'backspace')) { const c = this.chars.pop(); if (c) this.bytes -= Buffer.byteLength(c); }
    else if (matchesKey(data, 'ctrl+u')) { this.chars = []; this.bytes = 0; }
    else if (!this.type(data.replace(PASTE, ''))) return;
    this.tui.requestRender();
  }
  /** Appends printable characters (typed or pasted) within the size limit; other escape sequences are ignored. */
  private type(text: string): boolean {
    if (text.startsWith('\u001b')) return false;
    for (const c of text.replace(/[\r\n]+$/, '')) {
      if (/[\u0000-\u001f\u007f-\u009f]/.test(c) || this.bytes + Buffer.byteLength(c) > MAX_SECRET_BYTES) continue;
      this.chars.push(c); this.bytes += Buffer.byteLength(c);
    }
    return true;
  }
  private finish(value: Buffer | undefined) { this.closed = true; this.chars = []; this.bytes = 0; this.done(value); }
}

async function ask(ctx: ExtensionCommandContext, title: string): Promise<Buffer | undefined> {
  return await ctx.ui.custom<Buffer | undefined>((tui, _theme, _keys, done) => new SecretEntry(title, tui, done));
}

function listing(vault: Vault, profileId: string): string {
  const items = vault.list(profileId);
  if (!items.length) return 'No stored secrets.';
  return items.map(s => `${s.ref} · ${JSON.stringify(s.origin)} ${JSON.stringify(s.action)}${s.revoked ? ' · revoked' : ''}${s.expiresAt ? ` · expires ${new Date(s.expiresAt).toISOString()}` : ''}`).join('\n');
}

/** add/rotate: the binding comes from the arguments (add) or the existing active entry (rotate); the value only from the dialog. */
async function enter(ctx: ExtensionCommandContext, vault: Vault, profileId: string, action: string, rest: string[]): Promise<void> {
  const found = action === 'rotate' ? vault.list(profileId).find(s => s.ref === rest[0] && !s.revoked) : undefined;
  const binding = action === 'add' ? { profileId, origin: rest[0]!, action: rest[1]! } : found && { profileId, origin: found.origin, action: found.action };
  if (!binding) { ctx.ui.notify('No such active secret.', 'warning'); return; }
  const value = await ask(ctx, `${action === 'add' ? 'New' : 'Replace'} secret for ${JSON.stringify(binding.origin)} · action ${JSON.stringify(binding.action)}`);
  if (!value) { ctx.ui.notify('Cancelled; nothing stored.', 'info'); return; }
  try {
    if (action === 'add') ctx.ui.notify(`Stored as ${vault.put(value, binding)}. It cannot be read back; only injection into ${binding.origin} for "${binding.action}" uses it.`, 'info');
    else { vault.rotate(rest[0]!, binding, value); ctx.ui.notify(`Rotated ${rest[0]}.`, 'info'); }
  } finally { value.fill(0); }
}

/**
 * Operator-only secret entry. Values are typed into a masked dialog in the interactive terminal and go straight into
 * the vault; the model, RPC clients and the session only ever see opaque references.
 */
export function registerAssistantSecrets(pi: ExtensionAPI, source: () => { vault: Vault; profileId: string } | undefined) {
  pi.registerCommand('assistant-secret', { description: 'Store assistant secrets privately: list | add <origin> <action> | rotate <ref> | revoke <ref>', handler: async (args: string, ctx: ExtensionCommandContext) => {
    const [action = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const active = source();
    if (!active) { ctx.ui.notify('No assistant vault is open in this session.', 'info'); return; }
    const { vault, profileId } = active;
    const arity: Record<string, number> = { list: 0, add: 2, rotate: 1, revoke: 1 };
    if (arity[action] !== rest.length) { ctx.ui.notify(usage, 'error'); return; }
    try {
      if (action === 'list') ctx.ui.notify(listing(vault, profileId), 'info');
      else if (action === 'revoke') { vault.revoke(rest[0]!, profileId); ctx.ui.notify(`Revoked ${rest[0]}; its ciphertext is erased.`, 'info'); }
      else if (ctx.mode !== 'tui' || !ctx.hasUI) ctx.ui.notify('Secrets are entered only in the interactive terminal.', 'error');
      else await enter(ctx, vault, profileId, action, rest);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'vault_error';
      ctx.ui.notify(`Secret command refused (${code}); nothing was revealed.`, 'warning');
    }
  } });
}
