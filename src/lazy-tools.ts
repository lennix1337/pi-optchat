import type { ToolLoadout, ToolLoadoutChanges } from '@earendil-works/pi-coding-agent';

/**
 * Tools whose declarations the main agent's requests leave out. Each declaration (description and parameter schema) is re-sent with
 * every request; these tools made under 0.1% of the calls of the profile's last 15 days (each 0-37 of about 37,000), together about
 * 12 KB of declarations, about 3k tokens per request. They stay active, so the model still calls one from a `codemode` script as
 * `tools.<name>(args)` (`describeTool("<name>")` gives the arguments), and the on-demand index in the prompt names each one.
 *
 * Kept declared on purpose: tools the model calls directly more often, tools whose results are images (a script cannot show them to
 * the model), the ones OptChat itself watches by name (spawn, tell, crew, commitments, shells, self_reload), and tools no script can
 * call: Pi runs no nested call to a `model-only` tool (pi-subagents' `subagent_supervisor` and `contact_supervisor`), so its
 * declaration is the only way to it and it stays declared even when a profile lists it.
 * `lazyTools` in config.json replaces the list; `[]` declares every tool.
 */
export const LAZY_TOOLS: readonly string[] = [
  'lsp', 'repl', 'web_search', 'fetch_content', 'get_search_content', 'bg_wait', 'vault_run', 'vault_list', 'source_check',
  'create_goal', 'transcribe_file',
];

export const lazySet = (configured: readonly string[] | undefined): ReadonlySet<string> => new Set(configured ?? LAZY_TOOLS);

/** A tool's `prepareLoadout`: of the tools declared, those in the set that a script can call are left out of requests (Pi keeps them
 * active and callable). Only while `codemode` is declared: it is the way to call a tool whose declaration is gone. */
export const lazyLoadout = (lazy: () => ReadonlySet<string>) => (loadout: ToolLoadout): ToolLoadoutChanges | undefined => {
  const set = lazy(), names = loadout.declared.map(tool => tool.name), callable = new Set(loadout.callable.map(tool => tool.name));
  const hidden = names.includes('codemode') ? names.filter(name => set.has(name) && callable.has(name)) : [];
  return hidden.length ? { hiddenDeclarations: hidden } : undefined;
};
