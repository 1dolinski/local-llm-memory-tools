# local-llm-memory-tools

<p align="center">
  <img src="docs/hero.jpeg" alt="" width="480" />
</p>

<p align="center"><strong>Start building with local models</strong></p>

Install Ollama (paste in terminal, or <a href="https://ollama.com">download Ollama</a>):

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Pull the default model, then this app:

```bash
ollama pull gemma4
git clone https://github.com/1dolinski/local-llm-memory-tools.git
cd local-llm-memory-tools
npm install
cp .env.example .env
# set PRIVATE_KEY (USDC on Base for APINow) — optional: OLLAMA_MODEL
npm start
```

QMD is bundled (`@tobilu/qmd`). Optional: `npm install -g @tobilu/qmd`

---

**Why QMD + Gemma 4 + APINow (x402)** — **Gemma 4** runs locally via Ollama. **QMD** hybrid-searches your markdown (memories, chats). **APINow** pays per API call with **USDC / x402**—one wallet, no per-vendor API keys.

**Use:** `npm start` · `/tasks` `/memory` `/qmd` `/clear` · `quit` · `npm run start:verbose`

**More:** [ABOUT.md](ABOUT.md)
