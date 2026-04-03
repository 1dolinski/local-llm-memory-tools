import ollama from 'ollama';
import * as readline from 'readline';
import { config } from 'dotenv';
import { createClient } from 'apinow-sdk';
import {
  loadState,
  saveState,
  formatTasks,
  formatMemories,
  pushHistory,
  DATA_DIR,
} from './memory.js';
import { tools, handleToolCall, qmd } from './tools.js';
import { tryRoute } from './router.js';
import { setVerbose, vlog } from './log.js';
import { extractFactsInBackground, waitForExtractor, bootstrapMemories } from './extractor.js';
import { initDb, closeDb } from './db.js';
import { setCronChatFn, startCronJobs, stopAllCronJobs } from './cron.js';
import { startTelegramBot, setTelegramChatFn } from './telegram.js';
import type { Message } from 'ollama';

config();

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
setVerbose(VERBOSE);

const MODEL = process.env.OLLAMA_MODEL || 'gemma4';
const MAX_HISTORY = 50;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

function isModelInstalled(model: string, available: string[]): boolean {
  const bare = model.split(':')[0];
  return available.some((n) => {
    const nb = n.split(':')[0];
    return n === model || nb === bare;
  });
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const state = loadState();

const apinow = createClient({
  privateKey: process.env.PRIVATE_KEY as `0x${string}`,
});

let qmdStatus = '';

function refreshQmdStatus(): void {
  qmdStatus = qmd('status');
}

function buildSystemPrompt(): string {
  return `You are a helpful AI assistant with persistent memory, local document search via QMD, and access to external APIs via APINow.

## Your Memories
${formatMemories(state)}

## Current Task List
${formatTasks(state)}

## QMD Knowledge Base Status
${qmdStatus}

## CRITICAL RULES
- NEVER ask the user for information they already provided in the current message or that exists in your memories. Re-read the user's message and your memories before responding.
- Do NOT suggest horoscopes, weather APIs, or other external services unless the user asked for that kind of thing or it clearly follows from their request. Answer general chat, planning, and "what day is it" style questions without pivoting to unrelated tools.
- When you call tools, USE the results. If search_apis finds an API, immediately call get_api_info then call_api. Do NOT stop after searching and ask the user to repeat themselves.
- Complete the FULL action chain in one turn when an API is needed. Example: user asks for weather in Paris → search_apis → get_api_info → call_api with the right body. Another: user asks to translate a paragraph → find a translate endpoint → call_api. Do NOT stop midway and ask clarifying questions you already have answers to.
- Be action-oriented when tools are required. Do things, don't describe what you could do.

## APINow Workflow
When the user needs an external API:
1. search_apis to find matching endpoints — results contain "namespace" and "endpointName"
2. call_api with namespace and endpoint from results, plus the body params
Example: search finds namespace="acme", endpointName="weather" → call_api(namespace="acme", endpoint="weather", body={...params from get_api_info})
ALWAYS call the API in the same turn as the search. NEVER stop after searching and describe what you found — just call it.

## QMD Workflow
You manage the user's local knowledge base via QMD:
1. If QMD has NO collections: ask what directories to index
2. After qmd_collection_add: ALWAYS run qmd_embed then qmd_context_add
3. Search: qmd_search (fast keyword) or qmd_query (deep hybrid — best quality)
4. Retrieve: qmd_get with file path or docid from search results
5. When user mentions new docs/dirs: proactively offer to index them
6. Run qmd_update when user mentions changed files

## Cron Jobs
You can schedule recurring tasks with add_cron. Use list_crons to see scheduled jobs.
Example: user says "remind me to check the weather every morning" → add_cron(expression="0 8 * * *", prompt="what's the weather today", description="morning weather check")

## Database
You can query the app database with query_db (read-only SQL). Tables: cron_jobs, telegram_state.

## Task Management
- Proactively manage tasks: add new ones, move items between todo/upcoming/done as work progresses.
- When a task is completed, move it to done. When planning future work, use upcoming.

## Memory
- Save important facts, preferences, and context with save_memory.
- ALWAYS check your memories before asking the user something — they may have told you before.
- Be concise and direct.`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

let rlAsk: ((prompt: string) => Promise<string>) | undefined;

const conversationMessages: Message[] = [];

if (state.history.length) {
  for (const h of state.history) {
    conversationMessages.push({ role: h.role as any, content: h.content });
  }
}

/**
 * Core chat function. Used by CLI REPL, Telegram, and cron ticks.
 * onChunk is called with incremental text (for streaming to Telegram or stdout).
 */
export async function chat(
  userMessage: string,
  onChunk?: (text: string) => void,
): Promise<string> {
  const chatT0 = Date.now();
  vlog('chat', 'user input:', truncate(userMessage, 200));
  vlog('chat', 'conversation history:', conversationMessages.length, 'messages');
  vlog('chat', 'memories:', state.memories.length, '| known tools:', state.knownTools.length);

  conversationMessages.push({ role: 'user', content: userMessage });
  pushHistory(state, 'user', userMessage);

  while (conversationMessages.length > MAX_HISTORY) {
    conversationMessages.shift();
  }

  const routeT0 = Date.now();
  const routed = await tryRoute(userMessage, state, apinow, MODEL, rlAsk);
  if (routed) {
    vlog('chat', `router completed in ${Date.now() - routeT0}ms`);
  }

  const sysPrompt = buildSystemPrompt();
  vlog('chat', 'system prompt:', sysPrompt.length, 'chars');

  let messages: Message[] = [
    { role: 'system', content: sysPrompt },
    ...conversationMessages,
  ];

  if (routed) {
    messages.push({
      role: 'system',
      content: `[API result from ${routed.namespace}/${routed.endpoint}]\n${JSON.stringify(routed.data, null, 2)}\n\nUse this data to answer the user's question. Summarize it naturally and concisely. Do not invent details beyond what the API returned. Do not add emojis or extra formatting. Do not ask follow-up questions unless the user's request was ambiguous.`,
    } as Message);
  }

  const totalChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  vlog('chat', 'total context:', messages.length, 'messages,', totalChars, 'chars');

  let iterations = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let fullResponse = '';

  while (iterations++ < 15) {
    const t0 = Date.now();
    if (!onChunk) {
      process.stdout.write(dim(`  [turn ${iterations}] generating...`));
    }
    vlog('model', `iteration ${iterations}, sending ${messages.length} messages`);

    const stream = await ollama.chat({ model: MODEL, messages, tools, stream: true });

    let content = '';
    let toolCalls: any[] = [];
    let started = false;
    let partCount = 0;
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const part of stream) {
      partCount++;
      if (part.message.tool_calls?.length) {
        toolCalls.push(...part.message.tool_calls);
      }
      if (part.message.content) {
        if (!started) {
          if (!onChunk) {
            process.stdout.write(`\r                              \r\n${cyan('assistant>')} `);
          }
          started = true;
        }
        if (onChunk) {
          onChunk(part.message.content);
        } else {
          process.stdout.write(part.message.content);
        }
        content += part.message.content;
      }
      if ((part as any).prompt_eval_count) promptTokens = (part as any).prompt_eval_count;
      if ((part as any).eval_count) completionTokens = (part as any).eval_count;
    }

    totalPromptTokens += promptTokens;
    totalCompletionTokens += completionTokens;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    vlog('model', `stream done: ${partCount} parts, ${elapsed}s`);
    vlog('model', `tokens: prompt=${promptTokens} completion=${completionTokens}`);

    if (!started && !onChunk) {
      process.stdout.write(`\r                              \r`);
    }

    if (toolCalls.length) {
      vlog('model', `tool calls: ${toolCalls.map((tc: any) => tc.function.name).join(', ')}`);
      messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls } as Message);

      for (const tc of toolCalls) {
        const fnName = tc.function.name;
        const fnArgs = tc.function.arguments;
        if (!onChunk) {
          console.log(dim(`  [${fnName}] ${truncate(JSON.stringify(fnArgs), 80)} (${elapsed}s)`));
        }
        vlog('tool', `${fnName} args:`, fnArgs);

        const callT0 = Date.now();
        const result = await handleToolCall(fnName, fnArgs, state, apinow);
        const callElapsed = ((Date.now() - callT0) / 1000).toFixed(1);
        if (!onChunk) {
          console.log(dim(`  -> ${truncate(result, 150)} (${callElapsed}s)`));
        }
        vlog('tool', `${fnName} result (${callElapsed}s):`, result.length > 500 ? result.slice(0, 500) + '...' : result);

        messages.push({ role: 'tool', content: result });

        if (fnName.startsWith('qmd_collection') || fnName === 'qmd_embed' || fnName === 'qmd_update') {
          refreshQmdStatus();
        }
      }
      continue;
    }

    if (!onChunk) {
      if (started) {
        console.log(dim(` (${elapsed}s)`) + '\n');
      } else if (content) {
        console.log(`\n${cyan('assistant>')} ${content}` + dim(` (${elapsed}s)`) + '\n');
      }
    }

    vlog('chat', `total: ${iterations} iterations, prompt=${totalPromptTokens} completion=${totalCompletionTokens} tokens, ${((Date.now() - chatT0) / 1000).toFixed(1)}s`);

    conversationMessages.push({ role: 'assistant', content });
    pushHistory(state, 'assistant', content);
    fullResponse = content;

    extractFactsInBackground(userMessage, content, state, MODEL);

    try { qmd('update', 10_000); } catch {}
    return fullResponse;
  }

  vlog('chat', 'max iterations reached');
  if (!onChunk) {
    console.log(dim('  (max tool iterations reached)\n'));
  }
  return fullResponse;
}

async function main() {
  try {
    const list = await ollama.list();
    const available = list.models.map((m) => m.name);
    if (!isModelInstalled(MODEL, available)) {
      console.log(
        `Model "${MODEL}" not found locally. Available: ${available.join(', ')}`
      );
      console.log(`Pull it with: ollama pull ${MODEL}`);
      console.log(`Or set OLLAMA_MODEL env var to use a different model.`);
      process.exit(1);
    }
  } catch {
    console.error(
      'Could not connect to Ollama. Make sure it is running (ollama serve).'
    );
    process.exit(1);
  }

  // --- DB + Cron ---
  initDb();
  setCronChatFn(async (prompt) => { await chat(prompt); });
  startCronJobs();

  // --- QMD ---
  process.stdout.write(dim('  setting up qmd...'));
  const collectionList = qmd('collection list');
  if (!collectionList.includes('chat-memory')) {
    qmd(`collection add ${JSON.stringify(DATA_DIR)} --name chat-memory`);
    qmd('context add qmd://chat-memory "Chat conversations, saved memories, and task lists"');
  }
  qmd('update', 15_000);
  refreshQmdStatus();
  process.stdout.write('\r                          \r');

  const docMatch = qmdStatus.match(/Total:\s+(\d+)/);
  const docCount = docMatch ? docMatch[1] : '0';

  console.log('');
  console.log(cyan('  Hammock AI  |  ollama + apinow + qmd'));
  console.log(dim(`  model: ${MODEL}`));
  console.log(dim(`  wallet: ${apinow.wallet}`));
  console.log(dim(`  qmd: chat-memory (${docCount} docs)`));
  if (VERBOSE) console.log(dim('  verbose: ON'));
  console.log(dim('  commands: /tasks  /memory  /qmd  /clear  quit'));
  console.log('');

  bootstrapMemories(state, MODEL);

  // --- Telegram or CLI ---
  if (TELEGRAM_TOKEN) {
    console.log(dim('  mode: Telegram bot'));
    setTelegramChatFn(async (message, reply) => {
      const response = await chat(message, reply);
      if (!response) reply('(no response)');
    });
    await startTelegramBot(TELEGRAM_TOKEN);
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on('close', () => {
      stopAllCronJobs();
      closeDb();
      saveState(state);
      console.log('\nBye!');
      process.exit(0);
    });

    rlAsk = (prompt: string): Promise<string> =>
      new Promise((resolve) => rl.question(prompt, resolve));

    const ask = (): Promise<string> => rlAsk!('you> ');

    while (true) {
      const input = await ask();
      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed === 'quit' || trimmed === 'exit') {
        await waitForExtractor();
        stopAllCronJobs();
        closeDb();
        saveState(state);
        console.log('Bye!');
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/tasks') {
        console.log('\n' + formatTasks(state) + '\n');
        continue;
      }

      if (trimmed === '/memory') {
        console.log('\n' + formatMemories(state) + '\n');
        continue;
      }

      if (trimmed === '/qmd') {
        refreshQmdStatus();
        console.log('\n' + qmdStatus);
        continue;
      }

      if (trimmed === '/clear') {
        conversationMessages.length = 0;
        state.history = [];
        saveState(state);
        console.log(dim('  conversation cleared\n'));
        continue;
      }

      try {
        await chat(trimmed);
      } catch (err: any) {
        console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
      }
    }
  }
}

main();
