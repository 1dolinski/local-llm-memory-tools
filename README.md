# Hammock AI

<p align="center">
  <img src="docs/hero.jpeg" alt="" width="480" />
</p>

<p align="center"><strong>Start building with local models</strong></p>

## After install

**Just run:**

```bash
npm start
```

That starts the chat REPL. First-time setup (Ollama, clone, dependencies, `.env`) is below if you have not done it yet.

---

## First-time setup

Install Ollama (paste in terminal, or <a href="https://ollama.com">download Ollama</a>):

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Pull the default model, then this app:

```bash
ollama pull gemma4
git clone https://github.com/1dolinski/hammock-ai.git
cd hammock-ai
npm install
cp .env.example .env
# set PRIVATE_KEY (USDC on Base for APINow) — optional: OLLAMA_MODEL
```

Then **`npm start`** (see [After install](#after-install)).

QMD (`@tobilu/qmd`) is installed by `npm install` and runs automatically — no global install needed.

---

**Why QMD + Gemma 4 + APINow (x402)** — **Gemma 4** runs locally via Ollama. **QMD** hybrid-searches your markdown (memories, chats). **APINow** pays per API call with **USDC / x402**—one wallet, no per-vendor API keys.

**Use:** `npm start` · `/tasks` `/memory` `/qmd` `/clear` · `quit` · `npm run start:verbose`

**More:** [ABOUT.md](ABOUT.md)

---

## Advanced (optional)

All advanced features are opt-in. Base `npm start` works exactly as before.

### Cron jobs

Schedule recurring prompts from chat:

> "every morning at 8am, get my horoscope"

The model calls `add_cron("0 8 * * *", "get my horoscope")`. Jobs persist in SQLite (`data/app.sqlite`) and resume on restart.

Tools the model can use: `add_cron` `list_crons` `remove_cron` `toggle_cron`

### SQLite database

`npm install` sets up `data/app.sqlite` automatically (via `better-sqlite3`, already bundled). The model can run read-only SQL with `query_db`:

> "show me all my cron jobs that ran today"

### Telegram bot

Run the assistant as a Telegram bot instead of CLI:

1. Talk to [@BotFather](https://t.me/BotFather) and create a bot
2. Add to `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

3. `npm start` -- detects the token and starts polling Telegram instead of the REPL

Same tools, memory, and cron -- just a different frontend.
