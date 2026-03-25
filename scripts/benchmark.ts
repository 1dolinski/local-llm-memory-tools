/**
 * Quick generation benchmark: measures eval_count / total_duration via Ollama /api/generate.
 * Usage: npm run benchmark
 * Optional: OLLAMA_MODEL, OLLAMA_HOST, BENCH_TOKENS (default 80)
 */
import { config } from 'dotenv';

config();

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL_REQUESTED =
  process.env.OLLAMA_MODEL ||
  'kwangsuklee/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF';
const NUM_PREDICT = Math.min(512, Math.max(16, Number(process.env.BENCH_TOKENS || 80)));

/** Use the exact tag Ollama registered (e.g. ...:latest) to avoid resolution quirks. */
function resolveInstalledModel(requested: string, installed: string[]): string {
  if (installed.includes(requested)) return requested;
  const withLatest = `${requested}:latest`;
  if (installed.includes(withLatest)) return withLatest;
  const bare = requested.split(':')[0];
  const matches = installed.filter((n) => n.split(':')[0] === bare);
  if (matches.length === 0) return requested;
  return matches.find((n) => n.endsWith(':latest')) ?? matches[0];
}

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

  const t0 = performance.now();
  const genRes = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: 'In one short sentence, what is 2+2?',
      stream: false,
      options: { num_predict: NUM_PREDICT },
    }),
  });
  const wallMs = performance.now() - t0;

  if (!genRes.ok) {
    const t = await genRes.text();
    console.error('Generate failed', genRes.status, t);
    if (genRes.status === 500 && t.includes('unable to load model')) {
      printLoadFailureHelp(t, MODEL);
    }
    process.exit(1);
  }

  const d = (await genRes.json()) as {
    eval_count?: number;
    total_duration?: number;
    prompt_eval_count?: number;
    response?: string;
  };

  const sec = (d.total_duration ?? 0) / 1e9;
  const ev = d.eval_count ?? 0;
  const promptTok = d.prompt_eval_count;

  console.log('model:', MODEL);
  console.log('num_predict cap:', NUM_PREDICT);
  if (promptTok != null) console.log('prompt_eval_count:', promptTok);
  console.log('eval_count (completion tokens):', ev);
  console.log('ollama total_duration_s:', sec.toFixed(2));
  console.log('wall_clock_s:', (wallMs / 1000).toFixed(2));
  if (ev > 0 && sec > 0) {
    console.log('tok/s (eval_count / total_duration):', (ev / sec).toFixed(2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
