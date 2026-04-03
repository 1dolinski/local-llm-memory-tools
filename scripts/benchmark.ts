/**
 * Ollama generation benchmark.
 * Primary metric: eval_count / eval_duration (decode only — what people mean by "tok/s").
 * total_duration also includes model load + prompt prefill; first run is especially skewed.
 *
 * Usage: npm run benchmark  (default model: gemma4)
 * Optional: OLLAMA_MODEL, OLLAMA_HOST, BENCH_TOKENS (default 80), BENCH_NO_WARMUP=1,
 *           BENCH_PROMPT (override generation task — default aims for a long decode)
 */
import { config } from 'dotenv';
import { decodeTokPerSec, nsToSec, resolveInstalledModel } from './benchmark-utils.js';

config();

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL_REQUESTED = process.env.OLLAMA_MODEL || 'gemma4';
const NUM_PREDICT = Math.min(512, Math.max(16, Number(process.env.BENCH_TOKENS || 80)));
const NO_WARMUP = process.env.BENCH_NO_WARMUP === '1';

/** Long enough decode to stabilize tok/s (short answers hit EOS in a few tokens). */
const BENCH_PROMPT =
  process.env.BENCH_PROMPT ||
  'List the US state names in alphabetical order, one per line. Keep going until you have listed all 50.';

function printLoadFailureHelp(body: string, installedName: string): void {
  const m = body.match(/sha256-([a-f0-9]{64})/);
  const blob = m ? `sha256-${m[1]}` : null;
  const pullName = installedName.split(':')[0];
  console.error('\n--- Fix: "unable to load model" (corrupt blob or old Ollama) ---');
  console.error('1. Quit Ollama completely (menu bar app → Quit), then start it again.');
  console.error('2. Remove the model and the bad blob, then re-pull:');
  console.error(`   ollama rm ${JSON.stringify(installedName)}`);
  if (blob) {
    console.error(`   rm -f ~/.ollama/models/blobs/${blob}`);
  } else {
    console.error('   rm -f ~/.ollama/models/blobs/sha256-<hash-from-error-above>');
  }
  console.error(`   ollama pull ${JSON.stringify(pullName)}`);
  console.error('3. Upgrade Ollama: brew upgrade ollama  (needs recent llama.cpp for some GGUFs)');
  console.error('4. Same Ollama for pull + benchmark (not Docker vs menu-bar app).');
  console.error('5. If you used hf.co/Jackrong/... — that blob often fails in Ollama; try:');
  console.error(
    '   ollama pull kwangsuklee/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF'
  );
  console.error('   OLLAMA_MODEL=kwangsuklee/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF npm run benchmark');
  console.error('6. Fallback: OLLAMA_MODEL=qwen3.5:9b npm run benchmark\n');
}

interface GenerateDone {
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

async function generate(model: string, prompt: string, numPredict: number): Promise<GenerateDone> {
  const genRes = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { num_predict: numPredict },
    }),
  });
  if (!genRes.ok) {
    const t = await genRes.text();
    const err = new Error(t) as Error & { status: number; body: string };
    err.status = genRes.status;
    err.body = t;
    throw err;
  }
  return (await genRes.json()) as GenerateDone;
}

async function main(): Promise<void> {
  const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!tagsRes.ok) {
    console.error('Cannot reach Ollama at', OLLAMA_HOST, tagsRes.status);
    process.exit(1);
  }
  const tags = (await tagsRes.json()) as { models?: { name: string }[] };
  const names = (tags.models || []).map((m) => m.name);
  const bare = MODEL_REQUESTED.split(':')[0];
  const installed = names.some((n) => n.split(':')[0] === bare || n === MODEL_REQUESTED);
  if (!installed) {
    console.error(`Model not found locally: ${MODEL_REQUESTED}`);
    console.error('Installed:', names.length ? names.join(', ') : '(none)');
    console.error(`Run: ollama pull ${MODEL_REQUESTED}`);
    process.exit(1);
  }

  const MODEL = resolveInstalledModel(MODEL_REQUESTED, names);
  if (MODEL !== MODEL_REQUESTED) {
    console.log('resolved model tag:', MODEL, '(from', MODEL_REQUESTED + ')');
  }

  if (!NO_WARMUP) {
    process.stdout.write('warmup (loads weights into memory)... ');
    try {
      await generate(MODEL, 'Say hi.', 8);
      console.log('done');
    } catch (e: any) {
      console.log('');
      console.error('Warmup failed', e.status, e.body || e.message);
      if (e.status === 500 && String(e.body).includes('unable to load model')) {
        printLoadFailureHelp(e.body, MODEL);
      }
      process.exit(1);
    }
  }

  const t0 = performance.now();
  let d: GenerateDone;
  try {
    d = await generate(MODEL, BENCH_PROMPT, NUM_PREDICT);
  } catch (e: any) {
    console.error('Generate failed', e.status, e.body || e.message);
    if (e.status === 500 && String(e.body).includes('unable to load model')) {
      printLoadFailureHelp(e.body, MODEL);
    }
    process.exit(1);
  }
  const wallMs = performance.now() - t0;

  const ev = d.eval_count ?? 0;
  const evalSec = nsToSec(d.eval_duration);
  const loadSec = nsToSec(d.load_duration);
  const promptSec = nsToSec(d.prompt_eval_duration);
  const totalSec = nsToSec(d.total_duration);

  console.log('model:', MODEL);
  console.log('num_predict cap:', NUM_PREDICT);
  if (d.prompt_eval_count != null) console.log('prompt_eval_count:', d.prompt_eval_count);
  console.log('eval_count (completion tokens):', ev);
  console.log('load_duration_s:', loadSec.toFixed(3), '(often ~0 after warmup)');
  console.log('prompt_eval_duration_s:', promptSec.toFixed(3));
  console.log('eval_duration_s (decode only):', evalSec.toFixed(3));
  console.log('total_duration_s (load+prefill+decode):', totalSec.toFixed(3));
  console.log('wall_clock_s:', (wallMs / 1000).toFixed(2));
  console.log('');
  if (ev > 0 && evalSec > 0) {
    const dps = decodeTokPerSec(ev, d.eval_duration);
    console.log('tok/s (decode, eval_count / eval_duration):', dps.toFixed(2), '← use this for "how fast is generation"');
  }
  if (ev > 0 && totalSec > 0) {
    console.log('tok/s (end-to-end, eval_count / total_duration):', (ev / totalSec).toFixed(2), '(includes prefill; inflated if no warmup)');
  }
  console.log('');
  console.log('Tip: Old script used total_duration only — that mixes load + prefill + decode.');
  console.log('If decode tok/s is still low, check Activity Monitor (GPU), memory pressure, and `ollama ps`.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
