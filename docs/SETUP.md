# Setup Guide

Detailed setup for each knowledge source and the Teams app.

---

## 1. Azure OpenAI

1. Create an Azure OpenAI resource (any region with `gpt-4.1` + `text-embedding-3-small` quota).
2. In Azure OpenAI Studio → **Deployments**, create two deployments:
   - `gpt-4.1` (or `gpt-4o`, `gpt-4-turbo`, etc.)
   - `text-embedding-3-small` (1536 dims, used by this code)
3. Copy the endpoint URL and an API key.

```
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4.1
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
```

---

## 2. Microsoft Teams Bot

1. Go to [Azure Portal → Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot).
2. Create a new Azure Bot resource. Choose **Single Tenant** (cheapest) or **Multi Tenant**.
3. Note down the **Microsoft App ID** and create a client secret (App Password).
4. In the bot resource's **Configuration**, set the messaging endpoint to:
   ```
   https://<your-server-domain>/api/messages
   ```
5. Enable the **Microsoft Teams** channel under the bot's Channels.
6. Fill in `.env`:
   ```
   MICROSOFT_APP_ID=...
   MICROSOFT_APP_PASSWORD=...
   MICROSOFT_APP_TENANT_ID=...    # only for Single Tenant
   ```

### Teams App package

1. Copy `teams-app/manifest.example.json` → `teams-app/manifest.json`.
2. Replace `REPLACE-WITH-YOUR-AZURE-BOT-APP-ID` (twice) with your App ID.
3. Add icons:
   - `teams-app/color.png` — 192×192 PNG
   - `teams-app/outline.png` — 32×32 PNG with transparent background
4. Zip all three:
   ```bash
   cd teams-app && zip knowledge-bot.zip manifest.json color.png outline.png
   ```
5. Upload via [Teams Admin Center](https://admin.teams.microsoft.com) → Teams apps → Manage apps → Upload new app. Or sideload for testing via Teams desktop → Apps → Manage your apps → Upload a custom app.

---

## 3. Knowledge source: Wiki.js (optional)

Required: Wiki.js instance with SQL backend (PostgreSQL or Azure SQL).

1. Create a read-only SQL user with `SELECT` permission on `dbo.pages` and `dbo.users`.
2. For **write-back** (`#edit`, `#append`, `#publish`):
   - In Wiki.js → Administration → API Access → enable API.
   - Generate an API key with `manage:pages` and `manage:users` scopes.
3. Fill `.env`:
   ```
   KM_DB_SERVER=your-sql-server.database.windows.net
   KM_DB_NAME=wiki
   KM_DB_USER=...
   KM_DB_PASSWORD=...
   KM_BASE_URL=https://wiki.your-org.com/zh-tw
   WIKIJS_API_URL=https://wiki.your-org.com/graphql
   WIKIJS_API_TOKEN=...
   ```

---

## 4. Knowledge source: Google Docs (optional)

1. Create a Google Cloud project.
2. Enable the **Google Drive API** and **Google Docs API**.
3. Create a Service Account, download the JSON key, place it at `credentials/google-sa-key.json`.
4. **Share** the Drive folder containing your docs with the service account email (read access).
5. For **write-back** (publishing to a user's Drive), enable **Domain-wide Delegation** in Google Workspace Admin Console:
   - API controls → Domain-wide Delegation → Add new
   - Client ID: the service account's `client_id`
   - Scopes: `https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents`
6. Fill `.env`:
   ```
   GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./credentials/google-sa-key.json
   GOOGLE_DRIVE_FOLDER_ID=...   # root folder to sync recursively
   ```

The extractor reads both native Google Docs (with multi-tab support) and uploaded `.docx` files (via `mammoth`).

---

## 5. Knowledge source: Notion (optional)

1. Create an [internal integration](https://www.notion.so/my-integrations).
2. Capabilities needed:
   - **Read content** — required for sync
   - **Insert content** — required for `#publish` and `#append`
   - **Update content** — required for `#edit`
3. Share the parent page(s) you want to index with the integration (Notion → page → ⋯ → Connect to → your integration).
4. Fill `.env`:
   ```
   NOTION_API_KEY=secret_...
   NOTION_STATUS_FILTER=Done,Published   # optional, syncs only pages with these statuses
   ```

For publishing user notes to Notion, create a parent collector page and:
```
NOTION_PUBLISH_PARENT_PAGE_ID=<32-char hex page ID>
```

---

## 6. Image storage: Azure Blob (optional)

For user-uploaded images on notes/reminders.

1. Create a Storage Account (Standard LRS is enough).
2. Create a container named `note-images`, **Private access only** (no anonymous read).
3. Enable **Soft Delete** for blobs (7 days recommended) for accidental-delete protection.
4. Fill `.env`:
   ```
   AZURE_BLOB_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
   AZURE_BLOB_CONTAINER_NAME=note-images
   ```

---

## 7. Deploy to Azure App Service

```bash
# Build
npm run build

# Package (don't include .env, data/, credentials/ if you're committing the zip!)
zip -r deploy.zip dist/ node_modules/ package.json

# Deploy
az webapp deploy \
  --resource-group YOUR_RG \
  --name YOUR_APP \
  --src-path deploy.zip --type zip
```

### Critical Azure App Service settings

**Use 64-bit worker** (default is 32-bit, which OOMs Node):
```bash
az webapp config set --resource-group YOUR_RG --name YOUR_APP --use-32bit-worker-process false
```

**Enable Always On** so the bot doesn't sleep:
```bash
az webapp config set --resource-group YOUR_RG --name YOUR_APP --always-on true
```

**Persistent paths** (so deploys don't wipe state). In App Settings:
```
VECTOR_STORE_PATH=C:\home\data\vector-store.json
SYNC_STATE_PATH=C:\home\data\sync-state.json
DAILY_REMINDER_STATE_PATH=C:\home\data\daily-reminder-state.json
PERSONAL_DATA_DIR=C:\home\data\personal
PERSONAL_CONV_REFS_PATH=C:\home\data\conversation-refs.json
EDIT_SESSIONS_PATH=C:\home\data\edit-sessions.json
```

`wwwroot` is wiped on every zip-deploy. `C:\home\data\` is persistent.

**Timezone** (for cron schedules):
```
WEBSITE_TIME_ZONE=Taipei Standard Time
```

---

## 8. Verify

1. Hit `GET /api/health` — should return `{"status":"ok", "knowledgeBase": {...}}`.
2. Trigger a manual full sync:
   ```bash
   curl -X POST "https://your-domain/api/sync?token=YOUR_SYNC_SECRET"
   ```
3. Wait 5–10 minutes for embedding to complete, check `GET /api/health` again — `totalChunks` should be > 0.
4. In Teams, find the bot and ask a question that should be in your KB.
