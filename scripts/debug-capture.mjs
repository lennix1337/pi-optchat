import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SENSITIVE_HEADER_EXACT = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'cookie',
  'set-cookie',
  'x-goog-api-key',
  'anthropic-api-key',
  'openai-api-key',
  'x-session-token',
  'x-csrf-token',
]);

const SENSITIVE_HEADER_PATTERN = /(?:^|[-_])(auth|token|secret|key|password|credential|cookie|session)(?:$|[-_])/i;
const SENSITIVE_QUERY_PATTERN = /^(?:key|api_key|apikey|token|access_token|secret|auth|password|session)$/i;
const MAX_CAPTURE_RESPONSE_BYTES = 16 * 1024 * 1024;

export function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`debug-capture proxy only binds to loopback hosts (got "${host}")`);
  }
}

export function isSensitiveHeader(name) {
  const lower = String(name).toLowerCase();
  return SENSITIVE_HEADER_EXACT.has(lower) || SENSITIVE_HEADER_PATTERN.test(lower);
}

export function redactHeaders(headers) {
  const out = Object.create(null);
  if (!headers || typeof headers !== 'object') return out;
  for (const [rawKey, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    out[key] = isSensitiveHeader(key) ? '[REDACTED]' : value;
  }
  return out;
}

export function redactPath(rawPath) {
  const qIndex = rawPath.indexOf('?');
  if (qIndex === -1) return rawPath;
  const pathname = rawPath.slice(0, qIndex);
  const params = new URLSearchParams(rawPath.slice(qIndex + 1));
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_PATTERN.test(key)) params.set(key, 'REDACTED');
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function previewText(value, maxLen = 64) {
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 3)}...`;
  }
  if (isRecord(value)) {
    if (typeof value.name === 'string') return `tool:${value.name}`;
    if (typeof value.text === 'string') return previewText(value.text, maxLen);
    if (typeof value.type === 'string') return `type:${value.type}`;
  }
  return '';
}

export function extractCacheBreakpoints(payload) {
  if (!isRecord(payload)) return [];
  const breakpoints = [];

  if (Array.isArray(payload.tools)) {
    for (let i = 0; i < payload.tools.length; i++) {
      const tool = payload.tools[i];
      if (isRecord(tool) && isRecord(tool.cache_control)) {
        breakpoints.push({
          location: `tools[${i}]`,
          section: 'tools',
          index: i,
          cacheControl: { ...tool.cache_control },
          preview: previewText(tool),
        });
      }
    }
  }

  if (Array.isArray(payload.system)) {
    for (let i = 0; i < payload.system.length; i++) {
      const block = payload.system[i];
      if (isRecord(block) && isRecord(block.cache_control)) {
        breakpoints.push({
          location: `system[${i}]`,
          section: 'system',
          index: i,
          cacheControl: { ...block.cache_control },
          preview: previewText(block),
        });
      }
    }
  }

  if (Array.isArray(payload.messages)) {
    for (let m = 0; m < payload.messages.length; m++) {
      const msg = payload.messages[m];
      if (!isRecord(msg)) continue;
      if (isRecord(msg.cache_control)) {
        breakpoints.push({
          location: `messages[${m}]`,
          section: 'messages',
          index: m,
          cacheControl: { ...msg.cache_control },
          preview: previewText(msg.content),
        });
      }
      if (Array.isArray(msg.content)) {
        for (let b = 0; b < msg.content.length; b++) {
          const block = msg.content[b];
          if (isRecord(block) && isRecord(block.cache_control)) {
            breakpoints.push({
              location: `messages[${m}].content[${b}]`,
              section: 'messages',
              index: m,
              blockIndex: b,
              cacheControl: { ...block.cache_control },
              preview: previewText(block),
            });
          }
        }
      }
    }
  }

  if (isRecord(payload.cache_control)) {
    breakpoints.push({
      location: 'top',
      section: 'top',
      cacheControl: { ...payload.cache_control },
      preview: '',
    });
  }

  return breakpoints;
}

export function extractUsageMetrics(rawResponseText, contentType = '') {
  if (!rawResponseText) return null;
  const trimmed = rawResponseText.trim();
  if (!trimmed) return null;

  const isSse = contentType.toLowerCase().includes('text/event-stream')
    || trimmed.startsWith('event:')
    || trimmed.startsWith('data:');

  let inputTokens = null;
  let cachedTokens = null;
  let cacheWriteTokens = null;
  let outputTokens = null;
  let explicitPromptTokens = null;

  const applyUsage = (u) => {
    if (!isRecord(u)) return;
    if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
    if (typeof u.prompt_tokens === 'number') explicitPromptTokens = u.prompt_tokens;
    if (typeof u.cache_read_input_tokens === 'number') cachedTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number') cacheWriteTokens = u.cache_creation_input_tokens;
    if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
    if (typeof u.completion_tokens === 'number') outputTokens = u.completion_tokens;
    if (isRecord(u.prompt_tokens_details) && typeof u.prompt_tokens_details.cached_tokens === 'number') {
      cachedTokens = u.prompt_tokens_details.cached_tokens;
    }
    if (isRecord(u.input_tokens_details) && typeof u.input_tokens_details.cached_tokens === 'number') {
      cachedTokens = u.input_tokens_details.cached_tokens;
    }
  };

  if (isSse) {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const evt = JSON.parse(dataStr);
        if (isRecord(evt.usage)) applyUsage(evt.usage);
        if (isRecord(evt.message) && isRecord(evt.message.usage)) applyUsage(evt.message.usage);
      } catch {

      }
    }
  } else {
    try {
      const json = JSON.parse(trimmed);
      if (isRecord(json.usage)) applyUsage(json.usage);
      if (isRecord(json.message) && isRecord(json.message.usage)) applyUsage(json.message.usage);
    } catch {
      return null;
    }
  }

  if (
    inputTokens === null
    && explicitPromptTokens === null
    && cachedTokens === null
    && cacheWriteTokens === null
    && outputTokens === null
  ) {
    return null;
  }

  const cached = cachedTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  const promptTokens = explicitPromptTokens !== null
    ? explicitPromptTokens
    : (inputTokens ?? 0) + cached + cacheWrite;

  return {
    promptTokens,
    inputTokens: inputTokens ?? explicitPromptTokens ?? 0,
    cachedTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: outputTokens ?? 0,
    cacheHitRate: promptTokens > 0 ? +(cached / promptTokens).toFixed(4) : 0,
  };
}

function stripCacheControl(value) {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (!isRecord(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'cache_control') continue;
    out[k] = stripCacheControl(v);
  }
  return out;
}

function firstDiffByteOffset(bufA, bufB) {
  const minLen = Math.min(bufA.length, bufB.length);
  for (let i = 0; i < minLen; i++) {
    if (bufA[i] !== bufB[i]) return i;
  }
  return bufA.length === bufB.length ? null : minLen;
}

function snippetAtByte(buf, byteOffset, radius = 36) {
  const start = Math.max(0, byteOffset - 12);
  const end = Math.min(buf.length, byteOffset + radius);
  return buf.subarray(start, end).toString('utf8');
}

function buildCanonicalPrefix(payload, commonMessageCount) {
  if (!isRecord(payload)) return {};
  const messages = Array.isArray(payload.messages)
    ? payload.messages.slice(0, commonMessageCount)
    : undefined;
  return stripCacheControl({
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.tools !== undefined ? { tools: payload.tools } : {}),
    ...(payload.system !== undefined ? { system: payload.system } : {}),
    ...(messages !== undefined ? { messages } : {}),
  });
}

export function computePrefixSha256(payload) {
  if (!isRecord(payload)) return null;
  const msgCount = Array.isArray(payload.messages) ? payload.messages.length : 0;
  const canonical = JSON.stringify(buildCanonicalPrefix(payload, msgCount));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function diffPrefix(prevPayload, currPayload) {
  if (!isRecord(prevPayload) || !isRecord(currPayload)) {
    return {
      cacheBroken: false,
      firstDiffByte: null,
      prefixMatchBytes: 0,
      cause: null,
      breakpointWarning: null,
    };
  }

  const prevMsgs = Array.isArray(prevPayload.messages) ? prevPayload.messages : [];
  const currMsgs = Array.isArray(currPayload.messages) ? currPayload.messages : [];
  const commonLen = Math.min(prevMsgs.length, currMsgs.length);

  const prevPrefixBuf = Buffer.from(JSON.stringify(buildCanonicalPrefix(prevPayload, commonLen)), 'utf8');
  const currPrefixBuf = Buffer.from(JSON.stringify(buildCanonicalPrefix(currPayload, commonLen)), 'utf8');
  const firstDiffByte = firstDiffByteOffset(prevPrefixBuf, currPrefixBuf);

  const currBreakpoints = extractCacheBreakpoints(currPayload);
  const breakpointWarning = currBreakpoints.length > 4
    ? `cache_control breakpoint count (${currBreakpoints.length}) exceeds Anthropic limit of 4`
    : null;

  if (firstDiffByte === null) {
    return {
      cacheBroken: false,
      firstDiffByte: null,
      prefixMatchBytes: prevPrefixBuf.length,
      cause: null,
      breakpointWarning,
    };
  }

  const beforeSnippet = snippetAtByte(prevPrefixBuf, firstDiffByte);
  const afterSnippet = snippetAtByte(currPrefixBuf, firstDiffByte);

  if (prevPayload.model !== currPayload.model) {
    return {
      cacheBroken: true,
      firstDiffByte,
      prefixMatchBytes: firstDiffByte,
      cause: {
        section: 'model',
        kind: 'model_changed',
        byteOffset: firstDiffByte,
        sectionByteOffset: 0,
        beforeSnippet: String(prevPayload.model ?? ''),
        afterSnippet: String(currPayload.model ?? ''),
        reason: `model changed from "${prevPayload.model}" to "${currPayload.model}"`,
      },
      breakpointWarning,
    };
  }

  const prevTools = Array.isArray(prevPayload.tools) ? stripCacheControl(prevPayload.tools) : [];
  const currTools = Array.isArray(currPayload.tools) ? stripCacheControl(currPayload.tools) : [];
  const prevToolsBuf = Buffer.from(JSON.stringify(prevTools), 'utf8');
  const currToolsBuf = Buffer.from(JSON.stringify(currTools), 'utf8');
  const toolsDiff = firstDiffByteOffset(prevToolsBuf, currToolsBuf);

  if (toolsDiff !== null) {
    const maxTools = Math.max(prevTools.length, currTools.length);
    let idx = 0;
    for (; idx < maxTools; idx++) {
      if (JSON.stringify(prevTools[idx]) !== JSON.stringify(currTools[idx])) break;
    }
    const prevName = isRecord(prevTools[idx]) ? prevTools[idx].name : undefined;
    const currName = isRecord(currTools[idx]) ? currTools[idx].name : undefined;
    const toolName = currName ?? prevName ?? `index_${idx}`;
    let kind = 'tool_changed';
    if (idx >= prevTools.length) kind = 'tool_added';
    else if (idx >= currTools.length) kind = 'tool_removed';
    else if (prevName && currName && prevName !== currName) kind = 'tool_reordered';

    return {
      cacheBroken: true,
      firstDiffByte,
      prefixMatchBytes: firstDiffByte,
      cause: {
        section: 'tools',
        index: idx,
        toolName,
        kind,
        byteOffset: firstDiffByte,
        sectionByteOffset: toolsDiff,
        beforeSnippet,
        afterSnippet,
        reason: `tools[${idx}] (${toolName}) ${kind} at prefix byte ${firstDiffByte}`,
      },
      breakpointWarning,
    };
  }

  const prevSystem = stripCacheControl(prevPayload.system ?? null);
  const currSystem = stripCacheControl(currPayload.system ?? null);
  const prevSysBuf = Buffer.from(JSON.stringify(prevSystem), 'utf8');
  const currSysBuf = Buffer.from(JSON.stringify(currSystem), 'utf8');
  const sysDiff = firstDiffByteOffset(prevSysBuf, currSysBuf);

  if (sysDiff !== null) {
    let blockIndex;
    if (Array.isArray(prevSystem) && Array.isArray(currSystem)) {
      const maxBlocks = Math.max(prevSystem.length, currSystem.length);
      for (let b = 0; b < maxBlocks; b++) {
        if (JSON.stringify(prevSystem[b]) !== JSON.stringify(currSystem[b])) {
          blockIndex = b;
          break;
        }
      }
    }
    return {
      cacheBroken: true,
      firstDiffByte,
      prefixMatchBytes: firstDiffByte,
      cause: {
        section: 'system',
        ...(blockIndex !== undefined ? { blockIndex } : {}),
        kind: 'system_changed',
        byteOffset: firstDiffByte,
        sectionByteOffset: sysDiff,
        beforeSnippet,
        afterSnippet,
        reason: `system${blockIndex !== undefined ? `[${blockIndex}]` : ''} changed at prefix byte ${firstDiffByte}`,
      },
      breakpointWarning,
    };
  }

  const prevMsgsClean = stripCacheControl(prevMsgs.slice(0, commonLen));
  const currMsgsClean = stripCacheControl(currMsgs.slice(0, commonLen));
  const prevMsgsBuf = Buffer.from(JSON.stringify(prevMsgsClean), 'utf8');
  const currMsgsBuf = Buffer.from(JSON.stringify(currMsgsClean), 'utf8');
  const msgsDiff = firstDiffByteOffset(prevMsgsBuf, currMsgsBuf) ?? 0;

  let messageIndex = 0;
  for (let m = 0; m < commonLen; m++) {
    if (JSON.stringify(prevMsgsClean[m]) !== JSON.stringify(currMsgsClean[m])) {
      messageIndex = m;
      break;
    }
  }

  return {
    cacheBroken: true,
    firstDiffByte,
    prefixMatchBytes: firstDiffByte,
    cause: {
      section: 'messages',
      messageIndex,
      kind: 'message_mutated',
      byteOffset: firstDiffByte,
      sectionByteOffset: msgsDiff,
      beforeSnippet,
      afterSnippet,
      reason: `messages[${messageIndex}] mutated retroactively at prefix byte ${firstDiffByte}`,
    },
    breakpointWarning,
  };
}

export function analyzeTurns(turns) {
  const transitions = [];
  let cacheBreaks = 0;

  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const curr = turns[i];
    const diff = diffPrefix(prev.payload, curr.payload);
    if (diff.cacheBroken) cacheBreaks++;
    transitions.push({
      fromTurn: prev.turn,
      toTurn: curr.turn,
      ...diff,
    });
  }

  const totalPromptTokens = turns.reduce((sum, t) => sum + (t.usage?.promptTokens ?? 0), 0);
  const totalCachedTokens = turns.reduce((sum, t) => sum + (t.usage?.cachedTokens ?? 0), 0);

  return {
    turnCount: turns.length,
    cacheBreaks,
    totalPromptTokens,
    totalCachedTokens,
    overallCacheHitRate: totalPromptTokens > 0 ? +(totalCachedTokens / totalPromptTokens).toFixed(4) : 0,
    turns: turns.map(({ payload: _payload, ...meta }) => meta),
    transitions,
  };
}

export function analyzeCaptureDir(captureDir) {
  const dir = resolve(captureDir);
  const turnsPath = join(dir, 'turns.jsonl');
  const metaByTurn = new Map();

  if (existsSync(turnsPath)) {
    const lines = readFileSync(turnsPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const record = JSON.parse(line);
      metaByTurn.set(record.turn, record);
    }
  }

  const requestFiles = readdirSync(dir)
    .filter((name) => /^turn-\d+\.request\.json$/.test(name))
    .sort();

  const turns = [];
  for (const file of requestFiles) {
    const turnNum = Number(file.slice(5, 9));
    const raw = readFileSync(join(dir, file), 'utf8');
    let payload = null;
    try { payload = JSON.parse(raw); } catch {   }
    const meta = metaByTurn.get(turnNum) ?? { turn: turnNum };
    turns.push({ ...meta, payload });
  }

  if (turns.length === 0 && metaByTurn.size > 0) {
    for (const meta of [...metaByTurn.values()].sort((a, b) => a.turn - b.turn)) {
      turns.push({ ...meta, payload: null });
    }
  }

  return analyzeTurns(turns);
}

export function formatSummaryReport(summary) {
  const lines = [
    `Debug Capture Summary (${summary.turnCount} turns, ${summary.cacheBreaks} cache break(s), overall cache hit ${(summary.overallCacheHitRate * 100).toFixed(1)}%)`,
  ];

  for (const t of summary.turns) {
    const prompt = t.usage?.promptTokens ?? '-';
    const cached = t.usage?.cachedTokens ?? '-';
    const write = t.usage?.cacheWriteTokens ?? '-';
    const hit = t.usage ? `${(t.usage.cacheHitRate * 100).toFixed(1)}%` : '-';
    const bps = Array.isArray(t.breakpoints)
      ? t.breakpoints.map((b) => b.location).join(', ') || 'none'
      : 'none';
    lines.push(
      `  Turn ${t.turn}: ${t.statusCode ?? '-'} | TTFB ${t.ttfbMs ?? '-'}ms | prompt=${prompt} cached=${cached} write=${write} hit=${hit} | breakpoints=[${bps}]`,
    );
  }

  for (const tr of summary.transitions) {
    if (tr.cacheBroken && tr.cause) {
      lines.push(
        `  Break Turn ${tr.fromTurn} -> ${tr.toTurn}: ${tr.cause.reason} | before=${JSON.stringify(tr.cause.beforeSnippet)} after=${JSON.stringify(tr.cause.afterSnippet)}`,
      );
    } else {
      lines.push(`  Turn ${tr.fromTurn} -> ${tr.toTurn}: prefix preserved (${tr.prefixMatchBytes} bytes)`);
    }
    if (tr.breakpointWarning) {
      lines.push(`  Warning Turn ${tr.toTurn}: ${tr.breakpointWarning}`);
    }
  }

  return lines.join('\n');
}

function decodeBody(buf, encoding) {
  if (!buf.length) return buf;
  const enc = String(encoding ?? '').toLowerCase();
  try {
    if (enc === 'gzip') return gunzipSync(buf);
    if (enc === 'deflate') return inflateSync(buf);
    if (enc === 'br') return brotliDecompressSync(buf);
  } catch {
    return buf;
  }
  return buf;
}

function forwardHeaders(rawHeaders, targetHost) {
  const out = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    out[k] = v;
  }
  out.host = targetHost;
  return out;
}

export async function startCaptureProxy({
  target,
  host = '127.0.0.1',
  port = 0,
  outDir,
} = {}) {
  if (!target) throw new Error('target URL is required');
  assertLoopbackHost(host);

  const targetUrl = new URL(target);
  const captureDir = outDir ? resolve(outDir) : mkdtempSync(join(tmpdir(), 'pi-optchat-capture-'));
  mkdirSync(captureDir, { recursive: true });

  const turns = [];
  let turnSeq = 0;

  const server = http.createServer((clientReq, clientRes) => {
    const turn = ++turnSeq;
    const reqChunks = [];
    let reqBytes = 0;

    clientReq.on('data', (chunk) => {
      reqChunks.push(chunk);
      reqBytes += chunk.length;
    });

    clientReq.on('end', () => {
      const rawReqBuf = Buffer.concat(reqChunks);
      const decodedReqBuf = decodeBody(rawReqBuf, clientReq.headers['content-encoding']);
      const rawReqText = decodedReqBuf.toString('utf8');

      let payload = null;
      if (rawReqText.trim().startsWith('{')) {
        try { payload = JSON.parse(rawReqText); } catch {   }
      }

      const fileTag = String(turn).padStart(4, '0');
      if (rawReqText.length > 0) {
        writeFileSync(join(captureDir, `turn-${fileTag}.request.json`), decodedReqBuf);
      }

      const reqPath = clientReq.url || '/';
      const upstreamUrl = new URL(reqPath, targetUrl);
      const transport = upstreamUrl.protocol === 'https:' ? https : http;
      const startNs = process.hrtime.bigint();
      let ttfbMs = null;

      const upstreamReq = transport.request(upstreamUrl, {
        method: clientReq.method,
        headers: forwardHeaders(clientReq.headers, upstreamUrl.host),
      }, (upstreamRes) => {
        const resChunks = [];
        let resBytes = 0;
        let capturedResBytes = 0;

        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

        upstreamRes.on('data', (chunk) => {
          if (ttfbMs === null) {
            ttfbMs = Number(process.hrtime.bigint() - startNs) / 1e6;
          }
          resBytes += chunk.length;
          if (capturedResBytes < MAX_CAPTURE_RESPONSE_BYTES) {
            const slice = chunk.subarray(0, MAX_CAPTURE_RESPONSE_BYTES - capturedResBytes);
            resChunks.push(slice);
            capturedResBytes += slice.length;
          }
          clientRes.write(chunk);
        });

        upstreamRes.on('end', () => {
          if (ttfbMs === null) {
            ttfbMs = Number(process.hrtime.bigint() - startNs) / 1e6;
          }
          const totalMs = Number(process.hrtime.bigint() - startNs) / 1e6;
          clientRes.end();

          const rawResBuf = decodeBody(Buffer.concat(resChunks), upstreamRes.headers['content-encoding']);
          const usage = extractUsageMetrics(
            rawResBuf.toString('utf8'),
            String(upstreamRes.headers['content-type'] ?? ''),
          );

          const record = {
            turn,
            ts: new Date().toISOString(),
            method: clientReq.method ?? 'POST',
            path: redactPath(reqPath),
            statusCode: upstreamRes.statusCode ?? 0,
            ttfbMs: +ttfbMs.toFixed(2),
            totalMs: +totalMs.toFixed(2),
            requestBytes: reqBytes,
            responseBytes: resBytes,
            model: isRecord(payload) && typeof payload.model === 'string' ? payload.model : null,
            requestHeaders: redactHeaders(clientReq.headers),
            responseHeaders: redactHeaders(upstreamRes.headers),
            breakpoints: extractCacheBreakpoints(payload),
            usage,
            prefixSha256: computePrefixSha256(payload),
          };

          turns.push({ ...record, payload });
          appendFileSync(join(captureDir, 'turns.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
        });
      });

      upstreamReq.on('error', (error) => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'content-type': 'application/json' });
        }
        clientRes.end(JSON.stringify({ error: 'upstream_error', message: error.message }));
      });

      clientReq.on('aborted', () => upstreamReq.destroy());
      upstreamReq.end(rawReqBuf);
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen({ host, port }, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const proxyUrl = `http://${host === '::1' ? '[::1]' : host}:${actualPort}`;

  return {
    url: proxyUrl,
    host,
    port: actualPort,
    captureDir,
    analyze() {
      const summary = analyzeTurns(turns);
      writeFileSync(join(captureDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
      return summary;
    },
    async close() {
      const summary = this.analyze();
      await new Promise((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      });
      return summary;
    },
  };
}

const USAGE = [
  'Usage:',
  '  node scripts/debug-capture.mjs start --target <url> [--port <n>] [--host 127.0.0.1] [--out <dir>]',
  '  node scripts/debug-capture.mjs analyze <captureDir> [--json]',
].join('\n');

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const [cmd, ...rest] = argv;
  if (cmd === 'analyze') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
    const dir = positionals[0];
    if (!dir) {
      console.error(`Missing <captureDir>.\n${USAGE}`);
      return 2;
    }
    const summary = analyzeCaptureDir(dir);
    console.log(values.json ? JSON.stringify(summary, null, 2) : formatSummaryReport(summary));
    return 0;
  }

  if (cmd === 'start') {
    const { values } = parseArgs({
      args: rest,
      options: {
        target: { type: 'string' },
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '0' },
        out: { type: 'string' },
      },
    });
    if (!values.target) {
      console.error(`Missing --target <url>.\n${USAGE}`);
      return 2;
    }
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`Invalid --port "${values.port}".\n${USAGE}`);
      return 2;
    }
    const proxy = await startCaptureProxy({
      target: values.target,
      host: values.host,
      port,
      outDir: values.out,
    });
    console.log(JSON.stringify({ url: proxy.url, captureDir: proxy.captureDir }));
    await new Promise((resolveStop) => {
      const stop = async () => {
        const summary = await proxy.close();
        console.log(formatSummaryReport(summary));
        resolveStop();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  }

  console.error(`Unknown command "${cmd}".\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
