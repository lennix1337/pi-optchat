import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.ts';
import { exportBrowser } from '../src/browser.ts';
import { removeDir } from './support.ts';

class BrowserElement {
  children: Array<BrowserElement | string> = [];
  className = '';
  dataset: Record<string, string> = {};
  hidden = false;
  onclick?: () => void;
  style: Record<string, string> = {};
  title = '';
  private text = '';
  constructor(readonly tagName: string) {}
  get textContent() { return this.text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get childElementCount() { return this.children.filter(child => child instanceof BrowserElement).length; }
  get classList() {
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    const write = (next: string[]) => { this.className = [...new Set(next)].join(' '); };
    return {
      add: (...values: string[]) => write([...tokens(), ...values]),
      remove: (...values: string[]) => write(tokens().filter(token => !values.includes(token))),
      contains: (value: string) => tokens().includes(value),
      toggle: (value: string, force?: boolean) => {
        const enabled = force ?? !tokens().includes(value);
        write(enabled ? [...tokens(), value] : tokens().filter(token => token !== value));
        return enabled;
      },
    };
  }
  append(...values: Array<BrowserElement | string>) { this.children.push(...values); }
  setAttribute(_name: string, _value: string) {}
  querySelector(selector: string): BrowserElement | undefined {
    const [parent, child] = selector.split(' > ');
    if (parent === ':scope') {
      const [tag, cls] = child.split('.');
      return this.children.find((value): value is BrowserElement => value instanceof BrowserElement
        && (!tag || value.tagName === tag) && (!cls || value.classList.contains(cls)));
    }
    return undefined;
  }
}

function render(memory: Memory) {
  const html = readFileSync(exportBrowser(memory, 'test'), 'utf8');
  const [, data] = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/) ?? [];
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  const script = scripts.at(-1)?.[1];
  assert.ok(data && script);
  const elements = new Map<string, BrowserElement>();
  const document = {
    createElement: (tag: string) => new BrowserElement(tag),
    getElementById: (id: string) => {
      let element = elements.get(id);
      if (!element) { element = new BrowserElement('div'); elements.set(id, element); }
      return element;
    },
  };
  document.getElementById('data').textContent = data;
  new Function('document', script)(document);
  return document.getElementById('view');
}

test('memory browser embeds escaped data and a script that compiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-browser-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  try {
    memory.append('user', 'Hello </script><img src=x onerror=alert(1)> $& $1');
    memory.append('talk', 'Reply\nwith lines');
    const html = readFileSync(exportBrowser(memory, 'test'), 'utf8');
    const [, json] = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/) ?? [];
    assert.ok(json && !json.includes('<'));
    const data: unknown = JSON.parse(json);
    assert.ok(typeof data === 'object' && data !== null && 'root' in data && Array.isArray(data.root));
    assert.equal(data.root[0].text, 'Hello </script><img src=x onerror=alert(1)> $& $1');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0][1]));
  } finally { await memory.close(); removeDir(dir); }
});

test('memory browser does not call an unchanged leaf summary shortened', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-browser-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  try {
    memory.append('user', 'An ordinary short message.');
    await memory.settle(undefined, 'tree');
    const view = render(memory);
    const entry = view.children.find(child => child instanceof BrowserElement && child.dataset.k === '0:0');
    assert.ok(entry instanceof BrowserElement);
    assert.match(entry.textContent, /An ordinary short message\./);
    assert.doesNotMatch(entry.textContent, /shortened for the model/);
  } finally { await memory.close(); removeDir(dir); }
});

test('memory browser shows nested compressed leaves as summaries with the original available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-browser-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {}, 1);
  try {
    memory.append('user', 'An ordinary short message.');
    memory.append('talk', 'A long message. '.repeat(80));
    await memory.settle(undefined, 'tree');
    assert.deepEqual(memory.view, [{ l: 1, i: 0 }]);
    const view = render(memory);
    const parent = view.children.find(child => child instanceof BrowserElement && child.dataset.k === '1:0');
    assert.ok(parent instanceof BrowserElement);
    const toggle = parent.querySelector(':scope > button.link');
    assert.ok(toggle?.onclick);
    toggle.onclick();
    const children = parent.querySelector(':scope > .children');
    assert.ok(children);
    const [unchanged, compressed] = children.children;
    assert.ok(unchanged instanceof BrowserElement && compressed instanceof BrowserElement);
    assert.match(unchanged.textContent, /An ordinary short message\./);
    assert.doesNotMatch(unchanged.textContent, /shortened for the model/);
    assert.match(compressed.textContent, /shortened for the model/);
    assert.equal(compressed.querySelector(':scope > p.summary')?.textContent, memory.node({ l: 0, i: 1 })?.text);
    const originalToggle = compressed.querySelector(':scope > button.link');
    assert.equal(originalToggle?.textContent, 'Show the original');
    originalToggle?.onclick?.();
    assert.equal(compressed.querySelector(':scope > .children')?.hidden, false);
    assert.ok(compressed.textContent.includes(memory.root[1].text));
  } finally { await memory.close(); removeDir(dir); }
});

test('memory browser shows a tagged background message as a report, not as the user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-browser-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  try {
    const html = readFileSync(exportBrowser(memory, 'test'), 'utf8');
    const [source] = html.match(/function who\(e\) \{[\s\S]*?\n\}/) ?? [];
    assert.ok(source);
    const who = new Function(`${source}\nreturn who;`)() as (e: { kind: string, text: string }) => string[];
    assert.equal(who({ kind: 'user', text: '[8964a512] Done.' })[0], 'Subagent');
    assert.equal(who({ kind: 'user', text: '[subagent_result] Sub-agent "Scout" completed.' })[0], 'Subagent');
    assert.equal(who({ kind: 'user', text: '[web-search-results] 3 results.' })[0], 'Subagent');
    assert.equal(who({ kind: 'user', text: 'Fix [the] bug.' })[0], 'You');
    assert.equal(who({ kind: 'user', text: '[Historical Claude Code message]\nHi' })[0], 'You');
  } finally { await memory.close(); removeDir(dir); }
});
