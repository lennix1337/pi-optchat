import { Container, fuzzyFilter, getKeybindings, Input, SelectList, SettingsList, Spacer, Text, type Component, type SelectItem, type SettingItem } from '@earendil-works/pi-tui';
import { DynamicBorder, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { defaults, removeAlternate, roleModel, setAlternate, THINKING, type MainModel, type ProfileConfig, type Role } from './profiles.ts';
import { invalid, isNumberKey, SETTING_KEYS, SETTINGS, type NumberKey, type SettingKey } from './settings.ts';
import type { ModelChoice } from './compactor.ts';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

const ROLES: Record<Role, { label: string; description: string; applies: string }> = {
  compactor: { label: 'Compactor model', description: 'Writes memory summaries, imports and connected-window handoffs. Shortcut: /optchat model.', applies: 'Applies to the next summary.' },
  subagent: { label: 'Subagent model', description: 'Runs every subagent. Shortcut: /optchat agents model.', applies: 'Applies to subagents started after this.' },
};
const modelName = (choice: ModelChoice) => `${choice.provider}/${choice.model}`;
const showModel = (choice: ModelChoice) => `${modelName(choice)} · ${choice.thinking}`;
/** The value column: the model, then whether it is the default (shown short, without its provider). */
const modelValue = (theme: Theme, role: Role, choice: ModelChoice) => `${showModel(choice)}${theme.fg('dim', showModel(choice) === showModel(defaults[role])
  ? '  default' : `  default ${defaults[role].model} · ${defaults[role].thinking}`)}`;
const show = (key: SettingKey, value: number | boolean) => {
  const spec = SETTINGS[key];
  return typeof value === 'boolean' ? value ? 'on' : 'off' : spec.kind === 'number' && spec.unit ? `${value} ${spec.unit}` : String(value);
};

interface Options {
  profile: string; config: ProfileConfig;
  /** Each model with the thinking levels Pi can send it (Sonnet 5.5 has no "off"). */
  models: { name: string; thinking: readonly ThinkingLevel[] }[];
  /** Saves the whole profile config; throws if it can't be written. */
  save: (config: ProfileConfig) => void;
  /** The main model the roles follow right now, so the page can show which model each one really uses. */
  main?: MainModel;
}

/** A titled step inside the page: what it changes, the control, and its keys. */
function step(theme: Theme, title: string, description: string, control: Component, hint: string, extra: Component[] = []) {
  const box = new Container();
  for (const child of [new Text(theme.bold(theme.fg('accent', title)), 0, 0), new Spacer(1), new Text(theme.fg('muted', description), 0, 0),
    new Spacer(1), control, ...extra, new Spacer(1), new Text(theme.fg('dim', hint), 0, 0)]) box.addChild(child);
  return box;
}
const listTheme = (theme: Theme) => ({ selectedPrefix: (t: string) => theme.fg('accent', t), selectedText: (t: string) => theme.fg('accent', t),
  description: (t: string) => theme.fg('muted', t), scrollInfo: (t: string) => theme.fg('muted', t),
  noMatch: () => theme.fg('muted', '  No matching models. Pi lists the models you are logged in to.') });

/** Whole numbers only: typing replaces the value, Enter saves it, a bad value stays on screen with the reason. */
class NumberStep extends Container {
  private readonly input: Input;
  private readonly error = new Text('', 0, 0);
  constructor(theme: Theme, key: NumberKey, current: number, submit: (value: number) => string | undefined, cancel: () => void) {
    super();
    const spec = SETTINGS[key];
    // Empty with the current value as placeholder: typing starts a new value, Enter alone keeps the old one.
    this.input = new Input({ placeholder: String(current), placeholderStyle: text => theme.fg('dim', text) }); this.input.focused = true;
    this.input.onEscape = cancel;
    this.input.onSubmit = text => {
      if (!text.trim()) return cancel();
      const value = /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
      const problem = invalid(key, value) ?? submit(value);
      if (problem) this.error.setText(theme.fg('error', problem));
    };
    this.addChild(step(theme, `${spec.label}${spec.unit ? ` (${spec.unit})` : ''}`, `${spec.description} Default ${show(key, spec.default)}.`,
      this.input, 'Type a number · Enter to save · Esc to go back', [this.error]));
  }
  handleInput(data: string) { this.input.handleInput(data); }
}

/** Model first (type to filter), then thinking level; Esc goes back a step. */
class ModelStep extends Container {
  private active: { handleInput(data: string): void } = { handleInput: () => {} };
  constructor(private readonly theme: Theme, private readonly role: Role, private readonly models: Options['models'], private readonly current: ModelChoice,
    private readonly submit: (choice: ModelChoice) => string | undefined, private readonly cancel: () => void) {
    super();
    this.pickModel();
  }
  private pickModel() {
    const { theme, current } = this, filter = new Input();
    const items: SelectItem[] = this.models.map(({ name }) => ({ value: name, label: name, description: name === modelName(current) ? 'current' : undefined }));
    let list = new SelectList(items, 10, listTheme(theme));
    const build = () => {
      list = new SelectList(filter.getValue() ? fuzzyFilter(items, filter.getValue(), i => i.value) : items, 10, listTheme(theme));
      list.onSelect = item => this.pickThinking(item.value); list.onCancel = this.cancel;
      return list;
    };
    build(); list.setSelectedIndex(Math.max(0, this.models.findIndex(m => m.name === modelName(current))));
    filter.focused = true;
    const box = step(theme, ROLES[this.role].label, `${ROLES[this.role].description} Now ${showModel(current)}.`, filter, 'Type to filter · Enter to choose · Esc to go back', [new Spacer(1), list]);
    this.show(box, data => {
      const keys = getKeybindings();
      if ((['tui.select.up', 'tui.select.down', 'tui.select.confirm', 'tui.select.cancel'] as const).some(k => keys.matches(data, k))) return list.handleInput(data);
      filter.handleInput(data);
      const index = box.children.indexOf(list); box.children[index] = build();
    });
  }
  private pickThinking(model: string) {
    const { theme, current } = this, error = new Text('', 0, 0);
    const levels = this.models.find(m => m.name === model)?.thinking ?? THINKING;
    const list = new SelectList(levels.map(value => ({ value, label: value })), levels.length, listTheme(theme));
    list.setSelectedIndex(Math.max(0, levels.indexOf(current.thinking)));
    list.onCancel = () => this.pickModel();
    list.onSelect = item => {
      const thinking = levels.find(level => level === item.value);
      const slash = model.indexOf('/');
      const problem = thinking && this.submit({ provider: model.slice(0, slash), model: model.slice(slash + 1), thinking });
      if (problem) error.setText(theme.fg('error', problem));
    };
    this.show(step(theme, 'Thinking level', `For ${model}.`, list, 'Enter to save · Esc to go back', [error]), data => list.handleInput(data));
  }
  private show(box: Component, input: (data: string) => void) { this.clear(); this.addChild(box); this.active = { handleInput: input }; }
  handleInput(data: string) { this.active.handleInput(data); }
}

/** One entry per provider family: the role's model on the account the main model is on. Add, change and remove stay inside the step; Esc closes it and refreshes the row. */
class FallbackStep extends Container {
  private active: { handleInput(data: string): void } = { handleInput: () => {} };
  private readonly error = new Text('', 0, 0);
  constructor(private readonly theme: Theme, private readonly role: Role, private readonly o: Options, private readonly close: (value: string) => void) {
    super();
    this.showList();
  }
  private entries() { return this.o.config.alternates?.[this.role] ?? []; }
  private summary() { const entries = this.entries(); return entries.length ? entries.map(showModel).join('  ·  ') : 'none'; }
  private showList() {
    const { theme } = this, entries = this.entries(), name = ROLES[this.role].label.split(' ')[0].toLowerCase();
    const items: SelectItem[] = [
      ...entries.map((choice, index) => ({ value: `edit:${index}`, label: showModel(choice), description: `Used while the main model is on ${choice.provider}` })),
      { value: 'add', label: '+ Add a provider model', description: 'One entry per provider family; adding its family again replaces the entry' },
      ...(entries.length ? [{ value: 'remove', label: '− Remove a provider model', description: 'Choose the entry to delete' }] : []),
    ];
    const list = new SelectList(items, 10, listTheme(theme));
    list.setSelectedIndex(entries.length);
    list.onCancel = () => this.close(this.summary());
    list.onSelect = item => {
      if (item.value === 'add') this.showModel(undefined);
      else if (item.value === 'remove') this.showRemove();
      else this.showModel(entries[Number(item.value.slice('edit:'.length))]);
    };
    const description = `What the ${name} uses while the main model is on another provider, on that same account — numbered accounts included. Without an entry, the ${name} keeps its configured model, or runs the main model at its lowest effort.`;
    this.show(step(theme, `${ROLES[this.role].label.split(' ')[0]} fallbacks`, description, list, 'Enter to choose · Esc to go back', [this.error]), data => list.handleInput(data));
  }
  private showRemove() {
    const { theme } = this, entries = this.entries();
    const list = new SelectList(entries.map((choice, index) => ({ value: String(index), label: showModel(choice) })), 10, listTheme(theme));
    list.onCancel = () => this.showList();
    list.onSelect = item => { this.apply({ ...this.o.config.alternates, [this.role]: removeAlternate(entries, entries[Number(item.value)]) }); this.showList(); };
    this.show(step(theme, 'Remove a fallback', `The provider entry to remove. Esc leaves it in place.`, list, 'Enter to remove · Esc to go back'), data => list.handleInput(data));
  }
  private showModel(current: ModelChoice | undefined) {
    const model = new ModelStep(this.theme, this.role, this.o.models, current ?? this.o.config[this.role],
      choice => { this.apply({ ...this.o.config.alternates, [this.role]: setAlternate(this.entries(), choice) }); this.showList(); return undefined; },
      () => this.showList());
    this.show(model, data => model.handleInput(data));
  }
  private apply(alternates: ProfileConfig['alternates']) {
    const kept = Object.fromEntries(Object.entries(alternates ?? {}).filter(([, list]) => list?.length));
    const problem = update(this.o, { alternates: Object.keys(kept).length ? kept : undefined });
    this.error.setText(problem ? this.theme.fg('error', problem) : '');
  }
  private show(box: Component, input: (data: string) => void) { this.clear(); this.addChild(box); this.active = { handleInput: input }; }
  handleInput(data: string) { this.active.handleInput(data); }
}

/** Saves a change to the profile config and applies it in memory; returns the reason if it couldn't be written. */
function update(o: Options, patch: Partial<ProfileConfig>) {
  try { o.save({ ...o.config, ...patch }); }
  catch (error) { return `Could not save: ${error instanceof Error ? error.message : String(error)}`; }
  Object.assign(o.config, patch);
  return undefined;
}
/** Bordered, titled like Pi's own dialogs. */
function frame(theme: Theme, title: string, profile: string, body: Component[]) {
  const page = new Container();
  for (const child of [new DynamicBorder(s => theme.fg('border', s)), new Text(`${theme.bold(theme.fg('accent', title))}${theme.fg('muted', ` · ${profile}`)}`, 1, 0),
    ...body, new DynamicBorder(s => theme.fg('border', s))]) page.addChild(child);
  return page;
}

/** The page itself: Pi's settings list over this profile's config, one row per setting, saved on change. */
export function settingsPage(theme: Theme, o: Options, close: () => void, redraw = () => {}) {
  const { config } = o;
  const notice = new Text('', 2, 0);
  const marker = (same: boolean, fallback: string) => theme.fg('dim', same ? '  default' : `  default ${fallback}`);
  const value = (key: SettingKey, current: number | boolean) => `${show(key, current)}${marker(current === SETTINGS[key].default, show(key, SETTINGS[key].default))}`;
  const apply = (patch: Partial<ProfileConfig>, what: string, applies: string) => {
    const problem = update(o, patch);
    if (!problem) notice.setText(theme.fg('success', `Saved ${what}. `) + theme.fg('muted', applies));
    return problem;
  };
  const models = (['compactor', 'subagent'] as const).flatMap((role): SettingItem[] => {
    const { label, description, applies } = ROLES[role];
    const entries = config.alternates?.[role] ?? [];
    const now = o.main ? ` Now ${roleModel(config, role, o.main)}.` : '';
    return [
      { id: role, label, description: `${description} Default ${showModel(defaults[role])}.${now} ${applies}`,
        currentValue: modelValue(theme, role, config[role]),
        submenu: (_value, done) => new ModelStep(theme, role, o.models, config[role], choice => {
          const problem = apply({ [role]: choice }, `${label.toLowerCase()} ${showModel(choice)}`, applies);
          if (!problem) done(modelValue(theme, role, choice));
          return problem;
        }, () => done()),
      },
      { id: `${role}Fallbacks`, label: `${label.replace(' model', ' fallbacks')}`,
        description: `Models this role uses while the main model is on another provider, on that same account — numbered accounts included. Without an entry, the role keeps its configured model, or runs the main model at its lowest effort. Applies to the next call.`,
        currentValue: entries.length ? entries.map(showModel).join('  ·  ') : theme.fg('dim', 'none'),
        submenu: (_value, done) => new FallbackStep(theme, role, o, value => done(value)),
      },
    ];
  });
  const settings = SETTING_KEYS.map((key): SettingItem => {
    const spec = SETTINGS[key], base = { id: key, label: spec.label, description: `${spec.description} ${spec.applies}` };
    if (isNumberKey(key)) return { ...base, currentValue: value(key, config[key]),
      submenu: (_value, done) => new NumberStep(theme, key, config[key], next => {
        const problem = apply({ [key]: next }, `${spec.label.toLowerCase()} ${show(key, next)}`, spec.applies);
        if (!problem) done(value(key, next));
        return problem;
      }, () => done()) };
    return { ...base, currentValue: value(key, config[key]), values: [value(key, true), value(key, false)] };
  });
  const list = new SettingsList([...models, ...settings], 10, {
    label: (text, selected) => selected ? theme.fg('accent', text) : text,
    value: (text, selected) => selected ? theme.fg('accent', text) : theme.fg('muted', text),
    description: text => theme.fg('dim', text), cursor: theme.fg('accent', '→ '), hint: text => theme.fg('dim', text),
  }, (id, next) => {
    // Only the on/off rows change here; the others save from their own step.
    const key = SETTING_KEYS.find(k => k === id);
    if (!key || isNumberKey(key)) return;
    const on = next === value(key, true);
    const problem = apply({ [key]: on }, `${SETTINGS[key].label.toLowerCase()} ${on ? 'on' : 'off'}`, SETTINGS[key].applies);
    if (problem) { list.updateValue(key, value(key, config[key])); notice.setText(theme.fg('error', problem)); }
  }, close);
  const page = frame(theme, 'OptChat settings', o.profile, [
    new Text(theme.fg('dim', 'Saved as you change them · Victor\'s recipe by default'), 1, 0),
    new Spacer(1), list, notice]);
  return Object.assign(page, { handleInput: (data: string) => { notice.setText(''); list.handleInput(data); redraw(); } });
}

/** Just the settings page's model step, for /optchat model and /optchat agents model: closes with the saved choice, or nothing on Esc. */
export function modelPicker(theme: Theme, role: Role, o: Options, close: (choice?: ModelChoice) => void, redraw = () => {}) {
  const step = new ModelStep(theme, role, o.models, o.config[role], choice => {
    const problem = update(o, { [role]: choice });
    if (!problem) close(choice);
    return problem;
  }, () => close());
  return Object.assign(frame(theme, 'OptChat', o.profile, [new Spacer(1), step]), { handleInput: (data: string) => { step.handleInput(data); redraw(); } });
}

export function showSettings(ctx: ExtensionContext, o: Options) {
  return ctx.ui.custom<void>((tui, theme, _keys, done) => settingsPage(theme, o, () => done(undefined), () => tui.requestRender()));
}
/** Just the fallbacks step, for /optchat fallback and /optchat agents fallback: closes on Esc. */
export function showFallbacks(ctx: ExtensionContext, role: Role, o: Options) {
  return ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const step = new FallbackStep(theme, role, o, () => done(undefined));
    return Object.assign(frame(theme, 'OptChat', o.profile, [new Spacer(1), step]), { handleInput: (data: string) => { step.handleInput(data); tui.requestRender(); } });
  });
}
export function showModelPicker(ctx: ExtensionContext, role: Role, o: Options) {
  return ctx.ui.custom<ModelChoice | undefined>((tui, theme, _keys, done) => modelPicker(theme, role, o, done, () => tui.requestRender()));
}
