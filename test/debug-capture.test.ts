import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  analyzeCaptureDir,
  assertLoopbackHost,
  diffPrefix,
  extractCacheBreakpoints,
  extractUsageMetrics,
  formatSummaryReport,
  main,
  redactHeaders,
  redactPath,
  startCaptureProxy,
} from '../scripts/debug-capture.mjs';

async function startFakeProvider(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

test('refuses non-loopback host binding', async () => {
  assert.throws(() => assertLoopbackHost('0.0.0.0'), /loopback/i);
  assert.throws(() => assertLoopbackHost('192.168.1.10'), /loopback/i);
  await assert.rejects(
    () => startCaptureProxy({ target: 'http://127.0.0.1:9999', host: '0.0.0.0' }),
    /loopback/i,
  );
});

test('never records auth headers, cookies, or secret query params while forwarding them upstream', async () => {
  const secrets = [
    'sk-super-secret-bearer-token-98765',
    'ant-secret-api-key-54321',
    'session_cookie_secret_value_abc',
    'custom_header_token_xyz',
    'query_api_key_secret_111',
    'resp_set_cookie_secret_222',
    'resp_auth_token_secret_333',
  ];

  let seenUpstreamHeaders: http.IncomingHttpHeaders | undefined;
  let seenUpstreamUrl: string | undefined;
  const fake = await startFakeProvider(async (req, res) => {
    seenUpstreamHeaders = req.headers;
    seenUpstreamUrl = req.url;
    await readJsonBody(req);
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `sid=${secrets[5]}; HttpOnly`,
      'x-auth-token': secrets[6],
    });
    res.end(JSON.stringify({
      id: 'msg_1',
      usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
    }));
  });

  const outDir = mkdtempSync(join(tmpdir(), 'debug-capture-secrets-'));
  const proxy = await startCaptureProxy({ target: fake.url, outDir });

  try {
    const response = await fetch(`${proxy.url}/v1/messages?api_key=${secrets[4]}&beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secrets[0]}`,
        'x-api-key': secrets[1],
        cookie: `sid=${secrets[2]}`,
        'x-custom-token': secrets[3],
        'x-request-id': 'req-visible-id',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      }),
    });
    assert.equal(response.status, 200);
    await response.json();

    const summary = await proxy.close();


    assert.equal(seenUpstreamHeaders?.authorization, `Bearer ${secrets[0]}`);
    assert.equal(seenUpstreamHeaders?.['x-api-key'], secrets[1]);
    assert.equal(seenUpstreamUrl, `/v1/messages?api_key=${secrets[4]}&beta=true`);


    assert.equal(summary.turns[0].requestHeaders?.['x-request-id'], 'req-visible-id');
    assert.equal(summary.turns[0].requestHeaders?.authorization, '[REDACTED]');
    assert.equal(summary.turns[0].requestHeaders?.['x-api-key'], '[REDACTED]');
    assert.equal(summary.turns[0].requestHeaders?.cookie, '[REDACTED]');
    assert.equal(summary.turns[0].requestHeaders?.['x-custom-token'], '[REDACTED]');
    assert.equal(summary.turns[0].responseHeaders?.['set-cookie'], '[REDACTED]');
    assert.equal(summary.turns[0].responseHeaders?.['x-auth-token'], '[REDACTED]');
    assert.ok(summary.turns[0].path?.includes('api_key=REDACTED'));


    const files = readdirSync(outDir);
    assert.ok(files.includes('turns.jsonl'));
    assert.ok(files.includes('summary.json'));
    assert.ok(files.includes('turn-0001.request.json'));
    for (const file of files) {
      const content = readFileSync(join(outDir, file), 'utf8');
      for (const secret of secrets) {
        assert.equal(content.includes(secret), false, `secret leaked in ${file}`);
      }
    }


    const redacted = redactHeaders({ Authorization: 'Bearer abc', 'X-My-Secret': 'xyz', Accept: 'application/json' });
    assert.deepEqual({ ...redacted }, { authorization: '[REDACTED]', 'x-my-secret': '[REDACTED]', accept: 'application/json' });
    assert.equal(redactPath('/v1/chat?token=abc&model=x'), '/v1/chat?token=REDACTED&model=x');
  } finally {
    await fake.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('captures exact JSON, cache_control breakpoints, SSE & JSON usage, TTFB, and detects prefix breaks', async () => {
  let reqCount = 0;
  const fake = await startFakeProvider(async (req, res) => {
    reqCount++;
    await readJsonBody(req);
    await new Promise((r) => setTimeout(r, 15));

    if (reqCount === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1',
        usage: {
          input_tokens: 120,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 0,
          output_tokens: 40,
        },
      }));
      return;
    }

    if (reqCount === 2) {

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 50, cache_read_input_tokens: 1120, cache_creation_input_tokens: 0 } },
      })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 25 },
      })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }


    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_3',
      usage: {
        input_tokens: 1250,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 30,
      },
    }));
  });

  const outDir = mkdtempSync(join(tmpdir(), 'debug-capture-e2e-'));
  const proxy = await startCaptureProxy({ target: fake.url, outDir });

  const baseTools = [
    { name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } },
    { name: 'bash', description: 'Run a shell command', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
  ];
  const baseSystem = [
    { type: 'text', text: 'You are Pi.' },
    { type: 'text', text: 'Follow repo rules.', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];

  const turn1Body = {
    model: 'claude-sonnet-4-5',
    tools: baseTools,
    system: baseSystem,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Turn 1 question', cache_control: { type: 'ephemeral' } }] },
    ],
  };


  const turn2Body = {
    model: 'claude-sonnet-4-5',
    tools: baseTools,
    system: baseSystem,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Turn 1 question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Turn 1 answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'Turn 2 question', cache_control: { type: 'ephemeral' } }] },
    ],
  };


  const turn3Body = {
    model: 'claude-sonnet-4-5',
    tools: [
      baseTools[0],
      { name: 'bash', description: 'Run a shell command (MUTATED)', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
    ],
    system: baseSystem,
    messages: [
      ...turn2Body.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'Turn 2 answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'Turn 3 question', cache_control: { type: 'ephemeral' } }] },
    ],
  };

  try {
    for (const body of [turn1Body, turn2Body, turn3Body]) {
      const r = await fetch(`${proxy.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200);
      await r.text();
    }

    const summary = await proxy.close();
    assert.equal(summary.turnCount, 3);
    assert.equal(summary.cacheBreaks, 1);


    assert.equal(readFileSync(join(outDir, 'turn-0001.request.json'), 'utf8'), JSON.stringify(turn1Body));
    assert.equal(readFileSync(join(outDir, 'turn-0003.request.json'), 'utf8'), JSON.stringify(turn3Body));


    for (const t of summary.turns) {
      assert.ok(typeof t.ttfbMs === 'number' && t.ttfbMs >= 5, `expected TTFB >= 5ms, got ${t.ttfbMs}`);
    }
    assert.equal(summary.turns[0].usage?.promptTokens, 1120);
    assert.equal(summary.turns[0].usage?.cachedTokens, 0);
    assert.equal(summary.turns[1].usage?.promptTokens, 1170);
    assert.equal(summary.turns[1].usage?.cachedTokens, 1120);
    assert.equal(summary.turns[2].usage?.cachedTokens, 0);


    assert.deepEqual(
      summary.turns[0].breakpoints?.map((b) => b.location),
      ['tools[1]', 'system[1]', 'messages[0].content[0]'],
    );


    assert.equal(summary.transitions[0].cacheBroken, false);
    assert.equal(summary.transitions[0].firstDiffByte, null);
    assert.equal(summary.transitions[1].cacheBroken, true);
    assert.equal(summary.transitions[1].cause?.section, 'tools');
    assert.equal(summary.transitions[1].cause?.index, 1);
    assert.equal(summary.transitions[1].cause?.toolName, 'bash');
    assert.equal(summary.transitions[1].cause?.kind, 'tool_changed');
    assert.ok(typeof summary.transitions[1].firstDiffByte === 'number' && summary.transitions[1].firstDiffByte > 0);


    const diskSummary = analyzeCaptureDir(outDir);
    assert.equal(diskSummary.cacheBreaks, 1);
    assert.equal(diskSummary.transitions[1].cause?.toolName, 'bash');

    const report = formatSummaryReport(diskSummary);
    assert.match(report, /Break Turn 2 -> 3: tools\[1\] \(bash\) tool_changed at prefix byte \d+/);

    const capturedOut: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => capturedOut.push(args.map(String).join(' '));
    try {
      const exitCode = await main(['analyze', outDir, '--json']);
      assert.equal(exitCode, 0);
    } finally {
      console.log = origLog;
    }
    const cliSummary = JSON.parse(capturedOut.join('\n'));
    assert.equal(cliSummary.cacheBreaks, 1);
  } finally {
    await fake.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('diffPrefix pinpoints system block and retroactive message mutations', () => {
  const base = {
    model: 'claude-sonnet-4-5',
    tools: [{ name: 'zoom', description: 'Zoom memory', input_schema: { type: 'object' } }],
    system: [
      { type: 'text', text: 'Stable head' },
      { type: 'text', text: 'Dynamic view v1' },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Original prompt' }] },
    ],
  };

  const systemMutated = {
    ...base,
    system: [
      { type: 'text', text: 'Stable head' },
      { type: 'text', text: 'Dynamic view v2' },
    ],
    messages: [
      ...base.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
    ],
  };

  const sysDiff = diffPrefix(base, systemMutated);
  assert.equal(sysDiff.cacheBroken, true);
  assert.equal(sysDiff.cause?.section, 'system');
  assert.equal(sysDiff.cause?.blockIndex, 1);
  assert.equal(sysDiff.cause?.afterSnippet.includes('v2'), true);

  const msgMutated = {
    ...base,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Edited prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
    ],
  };

  const msgDiff = diffPrefix(base, msgMutated);
  assert.equal(msgDiff.cacheBroken, true);
  assert.equal(msgDiff.cause?.section, 'messages');
  assert.equal(msgDiff.cause?.messageIndex, 0);


  const overLimit = {
    ...base,
    tools: [{ name: 'zoom', cache_control: { type: 'ephemeral' } }],
    system: [
      { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '1', cache_control: { type: 'ephemeral' } }, { type: 'text', text: '2', cache_control: { type: 'ephemeral' } }] },
    ],
  };
  assert.equal(extractCacheBreakpoints(overLimit).length, 5);
  assert.match(diffPrefix(base, overLimit).breakpointWarning ?? '', /exceeds Anthropic limit of 4/);

  const oaiUsage = extractUsageMetrics(JSON.stringify({
    usage: { prompt_tokens: 500, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 400 } },
  }));
  assert.deepEqual(oaiUsage, {
    promptTokens: 500,
    inputTokens: 500,
    cachedTokens: 400,
    cacheWriteTokens: 0,
    outputTokens: 20,
    cacheHitRate: 0.8,
  });
});
