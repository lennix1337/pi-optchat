
import { runContextBenchmark } from '../../test/context-benchmark.ts';

const SAMPLES = 5;
const coldSamples = [];
let rows;
for (let i = 0; i < SAMPLES; i++) {
  rows = runContextBenchmark();
  coldSamples.push(Math.max(...rows.map(r => r.coldMs)));
}
coldSamples.sort((a, b) => a - b);
const medianColdMs = coldSamples[Math.floor(coldSamples.length / 2)];

const totalPreviewTokens = rows.reduce((sum, r) => sum + r.previewTokens, 0);
const minSavedPct = Math.min(...rows.map(r => r.savedVsPreviousPercent));
const zoomBytes = rows[0].zoomDescriptionBytes;

console.log(JSON.stringify([
  { metric: 'context.projection_preview_tokens', value: totalPreviewTokens, unit: 'tokens', lowerIsBetter: true, tolerancePct: 5 },
  { metric: 'context.projection_min_saved_pct', value: minSavedPct, unit: 'percent', lowerIsBetter: false, tolerancePct: 5 },
  { metric: 'context.projection_cold_ms', value: Math.round(medianColdMs * 1000) / 1000, unit: 'ms', lowerIsBetter: true, tolerancePct: 50 },
  { metric: 'context.zoom_description_bytes', value: zoomBytes, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
]));
