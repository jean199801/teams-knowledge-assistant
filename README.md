# Teams Knowledge Assistant

🌐 **English** | [繁體中文](./README.zh-TW.md)

> A Microsoft Teams bot that turns your scattered company knowledge — Wiki.js, Google Docs, Notion — into a single, conversational interface. Includes RAG with query rewriting, personal note-taking with image upload, and write-back to the knowledge base.

Built and deployed to production at a 30-person e-commerce company, currently handling ~5,000 knowledge chunks across three sources.

---

## ✨ Key Features

### 🔍 Multi-source RAG
- **Three knowledge sources unified**: Wiki.js (SQL), Google Docs (Drive API, including `.docx` uploads), Notion (database with status filter)
- **Hourly incremental sync** with persistent `lastSyncTime` (survives restarts, no wasted re-embedding)
- **Query rewriting**: short / vague questions are expanded into multiple semantic variants before embedding, dramatically improving recall on bare-noun queries (e.g. `Line推播設定位置？` finds `Line推播設定` even though the original phrasing scored that document outside the top 5)
- **Source priority boost**: tunable per-source ranking weights

### 📝 Personal assistant (per-user)
- `#note`, `#remind`, `#todo`, `#done` — slash commands
- Or just talk to it: *"remind me to call the vendor tomorrow at 2pm"*
- **Image attachments** (private blob storage, per-render SAS tokens)
- **Daily reminder push** with a self-healing polling safety net — survives `node-cron` silently dropping schedules in long-running cloud processes

### ✏️ Write-back to KB (the bot is read AND write)
- `#edit` — search any source, find docs containing the old text, preview, replace
- `#append` — add content to the end of an existing document
- `#publish` — turn a personal note into a published KM / Google Docs page, with AI-generated title and structure
- All Notion edits add an audit trail (`🕐 date username modified`) since Notion has no per-block edit history

### 🖼️ Image support throughout
- Upload images to notes and reminders (Teams attachments)
- Publish images to KM (base64-embedded) or Google Docs (inserted via Drive)
- Reminder push cards include attached images

### 🛡️ Privacy by design
- Images stored in private Azure Blob (no public URLs)
- Display via per-render SAS tokens (1-hour expiry by default)
- Published images are uploaded into the target platform's own storage and then deleted from Blob — the original storage is short-lived

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Microsoft Teams (1:1 chat or @mention in group)            │
└────────────────────────┬────────────────────────────────────┘
                         │ Bot Framework
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Express server (Node.js)                                   │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ Intent      │→ │ RAG          │→ │ Adaptive Card    │    │
│  │ classifier  │  │ - query      │  │ response with    │    │
│  │ (GPT-4)     │  │   rewriting  │  │ source links     │    │
│  │             │  │ - vector     │  │                  │    │
│  │ Routes:     │  │   search     │  │                  │    │
│  │ - RAG       │  │ - GPT-4      │  │                  │    │
│  │ - Personal  │  │   answer     │  │                  │    │
│  │ - Edit KB   │  │   generation │  │                  │    │
│  └─────────────┘  └──────────────┘  └──────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Knowledge sync (hourly, incremental)                │    │
│  │ Wiki.js SQL → Google Drive API → Notion API         │    │
│  │ → chunk → Azure OpenAI embed → in-memory vector DB  │    │
│  │ → persist to JSON                                   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
       │                  │                    │
       ▼                  ▼                    ▼
  Wiki.js (Azure SQL)  Google Drive       Notion API
  + GraphQL API        + Docs API
                       (read + write)
```

### Why this stack

- **Azure OpenAI** (not direct OpenAI/Anthropic): chosen because the production deployment lives in Azure East Asia. Direct OpenAI/Anthropic APIs return 403 from APAC servers. Azure OpenAI is an Azure-internal service with no geo restriction.
- **In-memory vector store** (not Qdrant / Pinecone): the codebase fits 30k chunks comfortably in 1.5 GB heap. Adding a vector DB was unnecessary infrastructure for the use case. The store persists to JSON with atomic rename.
- **Wiki.js + Google Docs + Notion**: matched the real org — different teams keep notes in different tools. The bot meets people where they already work.

---

## 🚀 Quick start

### Prerequisites

- Node.js 22+
- Azure OpenAI resource with `gpt-4.1` (or any chat completion model) and `text-embedding-3-small` deployments
- A Microsoft Teams app registration ([guide](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams))
- At least one of:
  - Wiki.js instance + Azure SQL access
  - Google Cloud project with a service account, Drive API enabled
  - Notion workspace with an internal integration

### 1. Install

```bash
git clone <your-fork-url> teams-knowledge-assistant
cd teams-knowledge-assistant
npm install
cp .env.example .env
# edit .env with your credentials
```

### 2. Run locally (without Teams)

The server exposes `POST /api/chat` so you can test RAG without Teams:

```bash
npm run dev
# in another terminal:
curl -X POST http://localhost:3200/api/chat \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I configure LINE push notifications?"}'
```

First run will be empty (no sync yet). Trigger a manual sync:

```bash
curl -X POST "http://localhost:3200/api/sync?token=YOUR_SYNC_SECRET"
```

### 3. Connect to Teams

1. Copy `teams-app/manifest.example.json` to `teams-app/manifest.json`, replace `REPLACE-WITH-YOUR-AZURE-BOT-APP-ID` with your Azure Bot App ID.
2. Add `color.png` (192×192) and `outline.png` (32×32) icons to `teams-app/`.
3. Zip the three files (`manifest.json` + 2 PNGs) and upload to your Teams Admin Center (or sideload for testing).
4. Deploy the server somewhere reachable from Microsoft's Bot Framework (e.g. Azure App Service). Configure the bot endpoint in Azure to point to `https://your-domain/api/messages`.

### 4. Deploy to Azure App Service (recommended)

```bash
npm run build
zip -r deploy.zip dist/ node_modules/ package.json
az webapp deploy --resource-group YOUR_RG --name YOUR_APP --src-path deploy.zip --type zip
```

**Critical**: configure persistent paths on App Service so deploys don't wipe the vector store. See [docs/SETUP.md](docs/SETUP.md) for the full list of `*_PATH` env vars that should point to `C:\home\data\` on Windows or `/home/data/` on Linux.

---

## 📂 Project structure

```
src/
├── index.ts                    # Server entrypoint + cron / polling setup
├── config.ts                   # All settings, sourced from env vars
├── routes/
│   ├── chat.ts                 # POST /api/chat — direct RAG endpoint
│   ├── teamsbot.ts             # POST /api/messages — Bot Framework
│   └── sync.ts                 # POST /api/sync — webhook for manual full sync
├── services/
│   ├── rag.ts                  # Multi-query RAG with rewriting
│   ├── vector-store.ts         # In-memory cosine similarity store
│   ├── embedding.ts            # Azure OpenAI embeddings (batched)
│   ├── claude.ts               # Chat completion (named legacy)
│   ├── personal-store.ts       # Notes & reminders (per-user JSON)
│   ├── personal-assistant.ts   # Intent classifier + handlers
│   ├── kb-edit.ts              # Find/replace + append across all 3 sources
│   ├── publish.ts              # Publish to KM / Google Docs (with images)
│   ├── wikijs-api.ts           # Wiki.js GraphQL client
│   ├── blob-storage.ts         # Azure Blob + SAS generation
│   ├── sync-state.ts           # lastSyncTime persistence
│   └── daily-reminder-state.ts # lastFiredAt persistence + catchup logic
├── etl/
│   ├── sync.ts                 # Multi-source sync orchestrator
│   ├── extract.ts              # Wiki.js SQL extract
│   ├── extract-gdocs.ts        # Google Docs + .docx via mammoth
│   ├── extract-notion.ts       # Notion API extract
│   ├── chunk.ts                # ## heading-aware chunking, 500 char max
│   └── clean.ts                # Markdown / HTML normalization
└── bot/
    ├── teams-bot.ts            # TeamsActivityHandler + message routing
    ├── adaptive-cards.ts       # RAG answer card
    ├── personal-cards.ts       # Notes / reminders / publish UI
    ├── edit-cards.ts           # Edit preview + confirmation UI
    └── proactive.ts            # Daily reminder push + SAS image cards
```

---

## 🧪 Lessons learned (the interesting bugs)

A non-exhaustive list of things that took real production usage to surface:

- **`node-cron` silently fails** on long-running processes for hour-level schedules. Short schedules (`*/5`) stay alive. Solution: keep cron, add a polling safety net that fires anything `lastFiredAt < mostRecentScheduledFire`.
- **`use32BitWorkerProcess: true` is the default on Azure App Service**, capping Node heap to ~90 MB regardless of `--max-old-space-size`. With a 6000-chunk vector store you OOM within the hour. Fix: `az webapp config set --use-32bit-worker-process false`.
- **wwwroot gets wiped on zip-deploy**, including `data/` if you store the vector store there. Lost a knowledge base this way. Fix: env-driven paths pointing to `C:\home\data\`.
- **Teams image attachments require Bearer auth** (`MicrosoftAppCredentials.getToken()`) — the `contentUrl` is a Bot Framework protected URL. Direct fetch returns 401.
- **Teams sends `image/*` content-type** (a wildcard), not `image/png`. Use magic-byte detection on the downloaded bytes.
- **Wiki.js draft pages have `isPublished=0` even when they look published in the UI**. RAG won't pick them up — confirm publish status, not just visibility.

These all eventually landed in [docs/POSTMORTEM.md](docs/POSTMORTEM.md) (TBD) if you're into that kind of reading.

---

## 🛣️ Roadmap / what I'd build next

- **Image OCR** during ingestion — many SOPs are screenshots with key information rendered as pixels. A pass with Azure Vision or GPT-4o on document images at sync time would substantially improve recall.
- **Hybrid search (BM25 + vector)** — exact term matching for proper nouns / IDs is a known weakness of pure dense retrieval.
- **Per-document feedback loop** — let users vote answers up/down to tune source boost dynamically.
- **Configurable LLM provider** — currently locked to Azure OpenAI; abstracting behind an interface would let users swap in direct OpenAI / Anthropic / Bedrock.

---

## 📄 License

MIT — see [LICENSE](LICENSE). Use commercially, fork freely, no warranty.

## 🙋 Contributing

This is a portfolio repo, but issues and PRs are welcome. If you want to discuss commercial customization or a similar build for your team, contact me via GitHub.
