# Teams Knowledge Assistant

[English](./README.md) | 🌐 **繁體中文**

> 一個 Microsoft Teams Bot，把散落在 Wiki.js、Google Docs、Notion 的公司知識整合成單一對話介面。包含**查詢改寫的 RAG**、**個人筆記與圖片上傳**，以及**寫回知識庫**的功能。

已在一間 30 人電商公司正式上線運作，目前管理 3 個來源、約 5,000 個知識片段。

---

## ✨ 核心功能

### 🔍 多來源 RAG
- **三大知識源整合**：Wiki.js（SQL）、Google Docs（Drive API，含上傳的 `.docx`）、Notion（含狀態篩選的 database）
- **每小時增量同步**，`lastSyncTime` 持久化（重啟後不重複 embed，省 token）
- **查詢改寫**：把短句、模糊問句先用 GPT 展開成多個語意變體再搜尋，大幅提升召回率（例如「Line推播設定位置？」原本搜不到正確文件，改寫後排第 1）
- **來源優先權重**：每個來源的排名分數可獨立調整

### 📝 個人助理（per-user）
- `#記` / `#提` / `#待` / `#完成` 等 slash 指令
- 也支援自然語言：「明天兩點提醒我跟廠商開會」
- **圖片附件**（私有 blob 儲存、每次顯示產生短期 SAS token）
- **每日提醒主動推送**，內建輪詢式安全網 —— 解決 `node-cron` 在雲端長期運行 process 中靜默漏跑的問題

### ✏️ 寫回知識庫（讀寫雙向）
- `#修改` — 跨來源搜尋包含舊文字的文件，預覽後逐份替換
- `#追加` — 在既有文件末尾補充內容
- `#發布` — 把個人筆記轉成 KM / Google Docs 正式頁面，AI 自動生成標題與排版
- Notion 修改會自動加上「🕐 日期 修改人 修改」的稽核記錄（因為 Notion 沒有 per-block 編輯歷史）

### 🖼️ 全流程圖片支援
- 透過 Teams attachment 上傳圖片到筆記、提醒
- 發布時把圖片帶到 KM（base64 嵌入）或 Google Docs（Drive 上傳）
- 提醒到期推送的卡片會顯示圖片

### 🛡️ 隱私設計
- 圖片存私有 Azure Blob（沒有公開 URL）
- 顯示時用短期 SAS token（預設 1 小時過期）
- 發布後圖片會上傳到目標平台自己的儲存空間，原始 blob 刪除 —— 短暫的儲存生命週期

---

## 🏗️ 架構

```
┌─────────────────────────────────────────────────────────────┐
│ Microsoft Teams（1 對 1 或群組 @mention）                   │
└────────────────────────┬────────────────────────────────────┘
                         │ Bot Framework
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Express server（Node.js）                                  │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ 意圖分類器  │→ │ RAG          │→ │ Adaptive Card    │    │
│  │ (GPT-4)     │  │ - 查詢改寫   │  │ 含來源連結       │    │
│  │             │  │ - 向量搜尋   │  │                  │    │
│  │ 路由：      │  │ - GPT-4      │  │                  │    │
│  │ - RAG       │  │   生成答案   │  │                  │    │
│  │ - 個人筆記  │  │              │  │                  │    │
│  │ - 修改知識  │  │              │  │                  │    │
│  └─────────────┘  └──────────────┘  └──────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 知識同步（每小時、增量）                            │    │
│  │ Wiki.js SQL → Google Drive API → Notion API         │    │
│  │ → 切片 → Azure OpenAI embed → 記憶體 vector DB      │    │
│  │ → 持久化到 JSON                                     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
       │                  │                    │
       ▼                  ▼                    ▼
  Wiki.js (Azure SQL)  Google Drive       Notion API
  + GraphQL API        + Docs API
                       （讀 + 寫）
```

### 為什麼用這個 stack

- **Azure OpenAI**（不是直連 OpenAI / Anthropic）：production 跑在 Azure East Asia，從亞洲 server 直連 OpenAI / Anthropic 會 403。Azure OpenAI 是 Azure 內部服務，沒這個問題。
- **記憶體向量庫**（不是 Qdrant / Pinecone）：3 萬個切片以內，1.5 GB heap 完全裝得下。多加一個 vector DB 對這個規模是多餘的基礎設施。儲存用 JSON + atomic rename。
- **Wiki.js + Google Docs + Notion**：對應真實的組織狀況 —— 不同團隊習慣用不同工具，bot 主動配合使用者的工具，不強迫遷移。

---

## 🚀 快速開始

### 前置需求

- Node.js 22+
- Azure OpenAI 資源，含 `gpt-4.1`（或任何 chat completion 模型）+ `text-embedding-3-small` deployment
- Microsoft Teams app registration（[文件](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams)）
- 至少一個知識來源：
  - Wiki.js 實例 + Azure SQL 連線
  - Google Cloud 專案 + Service Account + Drive API
  - Notion workspace + Internal Integration

### 1. 安裝

```bash
git clone <your-fork-url> teams-knowledge-assistant
cd teams-knowledge-assistant
npm install
cp .env.example .env
# 編輯 .env 填入你的憑證
```

### 2. 本機跑（不接 Teams 也能測）

伺服器有 `POST /api/chat`，可以不透過 Teams 直接測試 RAG：

```bash
npm run dev
# 另一個 terminal:
curl -X POST http://localhost:3200/api/chat \
  -H "Content-Type: application/json" \
  -d '{"question":"LINE 推播怎麼設定？"}'
```

第一次跑向量庫是空的，要先觸發同步：

```bash
curl -X POST "http://localhost:3200/api/sync?token=YOUR_SYNC_SECRET"
```

### 3. 串接 Teams

1. 複製 `teams-app/manifest.example.json` → `teams-app/manifest.json`，把 `REPLACE-WITH-YOUR-AZURE-BOT-APP-ID` 換成你的 Azure Bot App ID。
2. 加入 `color.png`（192×192）和 `outline.png`（32×32）icon。
3. 把這三個檔案打包成 zip，上傳到 Teams Admin Center（或 sideload 測試）。
4. 把 server 部署到 Microsoft Bot Framework 連得到的位置（Azure App Service 最簡單）。在 Azure 把 bot 的 messaging endpoint 設成 `https://your-domain/api/messages`。

### 4. 部署到 Azure App Service（推薦）

```bash
npm run build
zip -r deploy.zip dist/ node_modules/ package.json
az webapp deploy --resource-group YOUR_RG --name YOUR_APP --src-path deploy.zip --type zip
```

**重要**：要把持久化路徑設定好，否則每次部署知識庫會被清空。完整設定見 [docs/SETUP.md](docs/SETUP.md)。

---

## 📂 專案結構

```
src/
├── index.ts                    # 伺服器進入點 + cron / 輪詢設定
├── config.ts                   # 所有設定（從 env 讀）
├── routes/
│   ├── chat.ts                 # POST /api/chat — 直接 RAG 端點
│   ├── teamsbot.ts             # POST /api/messages — Bot Framework
│   └── sync.ts                 # POST /api/sync — 手動全量同步 webhook
├── services/
│   ├── rag.ts                  # 多查詢 RAG（含查詢改寫）
│   ├── vector-store.ts         # 記憶體 cosine similarity 儲存
│   ├── embedding.ts            # Azure OpenAI embedding（批次）
│   ├── claude.ts               # Chat completion（命名是歷史遺留）
│   ├── personal-store.ts       # 筆記 & 提醒（per-user JSON）
│   ├── personal-assistant.ts   # 意圖分類器 + handlers
│   ├── kb-edit.ts              # 跨三來源的搜尋 / 替換 / 附加
│   ├── publish.ts              # 發布到 KM / Google Docs（含圖片）
│   ├── wikijs-api.ts           # Wiki.js GraphQL client
│   ├── blob-storage.ts         # Azure Blob + SAS 產生
│   ├── sync-state.ts           # lastSyncTime 持久化
│   └── daily-reminder-state.ts # lastFiredAt 持久化 + 補跑邏輯
├── etl/
│   ├── sync.ts                 # 多來源同步協調
│   ├── extract.ts              # Wiki.js SQL 抽取
│   ├── extract-gdocs.ts        # Google Docs + mammoth 解析 .docx
│   ├── extract-notion.ts       # Notion API 抽取
│   ├── chunk.ts                # `## 標題` 切片，500 字上限
│   └── clean.ts                # Markdown / HTML 正規化
└── bot/
    ├── teams-bot.ts            # TeamsActivityHandler + 訊息路由
    ├── adaptive-cards.ts       # RAG 回答卡片
    ├── personal-cards.ts       # 筆記 / 提醒 / 發布 UI
    ├── edit-cards.ts           # 修改預覽 + 確認 UI
    └── proactive.ts            # 每日提醒推送 + SAS 圖片卡
```

---

## 🧪 踩過的坑（製作中的學習）

production 上線後真實踩到、寫成 commit 修掉的事，不完整列表：

- **`node-cron` 整點排程在長期 process 中靜默失效**。短週期排程（`*/5`）穩定，但每天 9/14/17 點的會「悄悄不跑」。解法：保留 cron，再加一個 10 分鐘輪詢的安全網，比對 `lastFiredAt < 最近排程時間` 就補跑。
- **Azure App Service 預設用 32-bit worker process**，Node heap 被砍到 90 MB，跟 `--max-old-space-size` 設多少無關。6000 個切片就 OOM。解法：`az webapp config set --use-32bit-worker-process false`。
- **wwwroot 在 zip-deploy 時會被清空**，包括 `data/` 如果你把 vector store 放那裡。曾經因此整個知識庫消失。解法：用 env 變數把路徑指到 `C:\home\data\`。
- **Teams 圖片附件下載需要 Bearer 認證**（`MicrosoftAppCredentials.getToken()`）—— `contentUrl` 是 Bot Framework 保護的 URL，直接 fetch 會 401。
- **Teams 傳來的 content-type 是 `image/*` 通配符**，不是 `image/png`。要用 magic-byte 偵測實際格式。
- **Wiki.js 草稿頁面 `isPublished=0`**，即使 UI 看起來已發布。RAG 抓不到，要確認 publish 狀態而非可見性。

完整 postmortem 之後會放在 [docs/POSTMORTEM.md](docs/POSTMORTEM.md)（TBD）。

---

## 🛣️ Roadmap / 下一步想做的

- **圖片 OCR**：很多 SOP 是截圖，關鍵資訊以像素呈現。在同步時用 Azure Vision 或 GPT-4o 對圖片做一次 pass，提升召回。
- **Hybrid search（BM25 + vector）**：純 dense retrieval 對專有名詞、ID 比對弱。
- **Per-document 回饋迴圈**：讓使用者對答案按讚 / 倒讚，動態調整來源權重。
- **可換的 LLM provider**：目前綁 Azure OpenAI；把它包成一層 interface 就能切到 OpenAI / Anthropic / Bedrock。

---

## 📄 License

MIT — 見 [LICENSE](LICENSE)。商業使用、改作、閉源衍生都可，無擔保。

## 🙋 貢獻 / 接案

這是我的作品集 repo，但歡迎 issue 和 PR。如果想討論客製化、或想為你的團隊建類似的系統，歡迎透過 GitHub 聯絡我。
