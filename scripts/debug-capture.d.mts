export interface CacheBreakpoint {
  location: string;
  section: 'tools' | 'system' | 'messages' | 'top';
  index?: number;
  blockIndex?: number;
  cacheControl: Record<string, unknown>;
  preview: string;
}

export interface UsageMetrics {
  promptTokens: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  cacheHitRate: number;
}

export interface PrefixDiffCause {
  section: 'model' | 'tools' | 'system' | 'messages';
  kind: string;
  index?: number;
  toolName?: string;
  blockIndex?: number;
  messageIndex?: number;
  byteOffset: number;
  sectionByteOffset: number;
  beforeSnippet: string;
  afterSnippet: string;
  reason: string;
}

export interface PrefixDiffResult {
  cacheBroken: boolean;
  firstDiffByte: number | null;
  prefixMatchBytes: number;
  cause: PrefixDiffCause | null;
  breakpointWarning: string | null;
}

export interface CaptureTurnRecord {
  turn: number;
  ts?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  ttfbMs?: number;
  totalMs?: number;
  requestBytes?: number;
  responseBytes?: number;
  model?: string | null;
  requestHeaders?: Record<string, string | string[]>;
  responseHeaders?: Record<string, string | string[]>;
  breakpoints?: CacheBreakpoint[];
  usage?: UsageMetrics | null;
  prefixSha256?: string | null;
}

export interface CaptureSummary {
  turnCount: number;
  cacheBreaks: number;
  totalPromptTokens: number;
  totalCachedTokens: number;
  overallCacheHitRate: number;
  turns: CaptureTurnRecord[];
  transitions: Array<PrefixDiffResult & { fromTurn: number; toTurn: number }>;
}

export interface CaptureProxyHandle {
  url: string;
  host: string;
  port: number;
  captureDir: string;
  analyze(): CaptureSummary;
  close(): Promise<CaptureSummary>;
}

export function assertLoopbackHost(host: string): void;
export function isSensitiveHeader(name: string): boolean;
export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]>;
export function redactPath(rawPath: string): string;
export function extractCacheBreakpoints(payload: unknown): CacheBreakpoint[];
export function extractUsageMetrics(rawResponseText: string, contentType?: string): UsageMetrics | null;
export function computePrefixSha256(payload: unknown): string | null;
export function diffPrefix(prevPayload: unknown, currPayload: unknown): PrefixDiffResult;
export function analyzeTurns(turns: Array<CaptureTurnRecord & { payload?: unknown }>): CaptureSummary;
export function analyzeCaptureDir(captureDir: string): CaptureSummary;
export function formatSummaryReport(summary: CaptureSummary): string;
export function startCaptureProxy(options: {
  target: string;
  host?: string;
  port?: number;
  outDir?: string;
}): Promise<CaptureProxyHandle>;
export function main(argv?: string[]): Promise<number>;
