# local-llm-memory-tools

Cloud AI knows everything about you and nothing stays on your machine. Your conversations, preferences, and context live on someone else's server. Local models fix the privacy problem but create new ones — they forget everything between sessions, can't search their own history, and have no way to call external services.

This project solves three problems:

1. **Your context stays local.** Conversations, memories, and documents never leave your machine. Everything is stored as plain markdown files you own and can read.

2. **Your AI remembers you.** Hard facts and preferences are automatically extracted from every conversation and persisted in a vectorized local index. Your zodiac sign, your job, your allergies — mentioned once, remembered forever.

3. **A 9B model gets real tool access.** A deterministic router handles API discovery, parameter extraction, and execution *before* the model even sees the message. The model stays focused on conversation while the router gives it capabilities that normally require 100B+ parameter models.

Built on **Qwen 3.5:9B** via Ollama, **QMD** for vectorized memory/search, and **APINow** for x402-protocol paid API access.

## Quick Start

### 1. Install Ollama

Download from [ollama.com](https://ollama.com), then pull the model ([Qwen 3.5:9B](https://ollama.com/library/qwen3.5:latest)):

```bash
# Install Ollama (macOS)
brew install ollama

# Pull and start Qwen 3.5:9B (~5.5GB)
ollama run qwen3.5:9b
```

### 2. Install QMD

[QMD](https://github.com/tobi/qmd) is a local document search engine with BM25 + vector hybrid search.

```bash
npm install -g @tobilu/qmd
```

### 3. Get an APINow Private Key

[APINow](https://apinow.fun) uses the **x402 payment protocol** — your AI pays for API calls with **USDC** using an EVM private key. No API keys, no subscriptions.

1. Use any EVM wallet (MetaMask, Coinbase Wallet, etc.) or generate a new key
2. Fund the wallet with USDC on **Base** — even $1 is enough for hundreds of API calls
3. Copy the private key

### 4. Clone & Run

```bash
git clone https://github.com/1dolinski/local-llm-memory-tools.git
cd local-llm-memory-tools
npm install

# Set up your private key
cp .env.example .env
# Edit .env and paste your private key
```

Your `.env` file should look like:

```env
# EVM private key for USDC payments via APINow (x402 protocol)
PRIVATE_KEY=0xabc123...your_private_key_here

# Optional: override the default model
# OLLAMA_MODEL=qwen3.5:9b
```

Then start chatting:

```bash
npm start

# Or with verbose logging (token counts, search timing, tool calls)
npm run start:verbose
```

---

## Why Qwen 3.5:9B?

Qwen 3.5:9B punches way above its weight class. It outperforms models 10-15x its size on several benchmarks and holds its own against frontier models — all while running locally at **~15 tok/s on an M5 MacBook Pro (24GB)**.

![Qwen 3.5 Benchmarks](docs/qwen-benchmarks.png)

| Benchmark | Qwen3.5-9B | GPT-oss-120B | Qwen3-Next-80B | Gemini 2.5 Flash-Lite |
|---|---|---|---|---|
| **IFBench** (instruction following) | 64.5 | 69.0 | 65.1 | — |
| **GPQA Diamond** (grad-level reasoning) | 81.7 | 77.2 | 80.1 | 71.5 |
| **HMMT Feb 2025** (math tournament) | 83.2 | 73.7 | 90.0 | 76.7 |
| **MMMLU** (multilingual knowledge) | 81.2 | 81.3 | 78.2 | 69.7 |
| **MMMU-Pro** (visual reasoning) | 70.1 | 63.0 | 59.7 | — |
| **ERQA** (embodied reasoning) | 55.5 | 45.8 | 44.3 | — |

The 9B size is the sweet spot for local inference — fast enough for real-time chat with tool calling, smart enough to handle multi-step reasoning, parameter extraction, and fact extraction without melting your laptop.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Chat Loop                      │
│  user message → router → model → stream response │
├──────────┬──────────┬──────────┬────────────────┤
│  Router  │ Extractor│   QMD    │    APINow      │
│ (pre-LLM │ (bg fact │ (vector  │  (x402 tool    │
│  API     │  mining) │  memory) │   calling)     │
│  dispatch│         │          │                │
└──────────┴──────────┴──────────┴────────────────┘
```

**6 modules, single-process:**

| File | Purpose |
|---|---|
| `src/index.ts` | Chat loop, streaming, system prompt, CLI commands |
| `src/router.ts` | Deterministic pre-LLM API routing — matches known tools or searches for new ones, extracts params, calls APIs before the model even sees the message |
| `src/extractor.ts` | Background fact extractor — mines hard facts & preferences from every conversation turn without blocking chat |
| `src/memory.ts` | Persistent state: tasks, memories, conversation history, known tools. Writes markdown for QMD indexing |
| `src/tools.ts` | Ollama tool schemas + handlers for tasks, memory, APINow, and QMD |
| `src/log.ts` | Verbose timestamped logging |

## Key Features

### Automatic Memory Extraction

Every user message is analyzed in the background by a separate model call that extracts hard facts and preferences — names, locations, zodiac signs, birthdays, job titles, allergies, favorites, relationships, tech stack, etc. These are deduplicated against existing memories and persisted to both JSON and markdown (for QMD indexing).

On startup, if conversation history exists but no memories have been extracted yet, it bootstraps by processing past messages.

### QMD — Vectorized Local Memory & Search

[QMD](https://github.com/tobi/qmd) provides the local knowledge layer:

- **BM25 keyword search** — fast exact matching across all indexed docs
- **Hybrid deep search** — BM25 + vector search + query expansion + LLM reranking
- **Auto-indexing** — conversations, memories, and tasks are written as markdown files and automatically indexed
- **Embedding** — vector embeddings generated locally for semantic search
- **Context** — collections can be annotated with descriptions to improve search relevance

The assistant's entire operational history (conversations, saved memories, task lists) lives as markdown files in `data/` and is indexed by QMD, making everything semantically searchable.

### APINow — x402 Tool Calling

[APINow](https://apinow.fun) is an API marketplace that uses the **x402 payment protocol** for machine-to-machine API access:

- **Vectorized API search** — find relevant APIs by natural language description
- **x402 payments** — APIs are paid per-call using **USDC** with your private key, no subscriptions or API keys per service
- **Evals** — tools on APINow are vetted through evaluations so the AI can trust tool quality
- **Deterministic routing** — the router matches user intent to known tools instantly, or discovers new ones via search
- **Parameter resolution** — params are resolved from user memory and conversation context, only falling back to a model call for truly new tools

API providers can list their APIs on APINow and get paid in USDC every time an AI agent calls them.

### Deterministic API Router

The router runs **before** the main LLM to handle API calls reliably:

1. **Known tool match** — keyword matching against previously used tools, params resolved from memory (no model call needed)
2. **New tool discovery** — APINow search → focused param extraction model call → API execution
3. **Tool registration** — successful calls are saved with keywords for instant future matching
4. **Conflict resolution** — if memory says one thing but the cached params say another, it asks the user

### Task Management

Built-in todo / upcoming / done lists managed through natural language. Tasks persist across sessions.

## Usage

```
  Chat Assistant  |  ollama + apinow + qmd
  model: qwen3.5:9b
  wallet: 0x...
  qmd: chat-memory (12 docs)
  commands: /tasks  /memory  /qmd  /clear  quit

you> my zodiac is cancer, what's my horoscope
  [memory] saved: User's zodiac sign is Cancer
  [router] matched known tool: gg402/horoscope
  [router] params: {"zodiac_sign":"Cancer"}
  [router] -> called gg402/horoscope (1.2s)

assistant> Today's horoscope for Cancer: ...
```

### Commands

| Command | Description |
|---|---|
| `/tasks` | Show todo / upcoming / done lists |
| `/memory` | Show all saved memories |
| `/qmd` | Show QMD index status |
| `/clear` | Clear conversation history |
| `quit` | Save and exit |

## How It Works

1. **You type a message** → pushed to conversation history + saved as markdown for QMD
2. **Router checks** → does this match a known API tool? If yes, resolve params from memory and call it. If it looks like an API request, search APINow for tools
3. **Background extractor fires** → a separate model call extracts hard facts from the conversation turn, deduplicates, and saves to memory + QMD
4. **Main model responds** → with full context (memories, tasks, QMD status, API results if routed), streaming response with tool calling support
5. **QMD updates** → index refreshed after each turn

## Verbose Mode

`npm run start:verbose` logs everything:

- Token counts (prompt + completion) per model call
- Router decisions, keyword matching, param resolution
- APINow search timing and results
- API call timing and responses
- Extractor fact mining results and dedup decisions
- Full timestamps on every operation

## License

MIT
