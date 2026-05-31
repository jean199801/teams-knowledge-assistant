# Architecture Notes

Deeper dive into the design decisions and patterns. Companion to the [README](../README.md).

---

## RAG pipeline

```
user question
   │
   ▼
classifyIntent (GPT-4)                    ← decides knowledge query vs personal action
   │
   ├─→ knowledge_query  → ragQuery
   ├─→ search_personal  → personal note search (with RAG fallback if 0 results)
   ├─→ add_reminder     → personal-store.addReminder
   ├─→ list_notes       → personal-store.listNotes
   ├─→ edit_kb          → edit flow (find target docs → preview → confirm)
   └─→ ... etc.
```

### ragQuery details

```
question
   │
   ▼
expandQuery (GPT-4, low temp)              ← 0-2 semantic variants
   │
   ▼
[original, variant1, variant2]
   │
   ▼
embedBatch (Azure OpenAI)                   ← parallel embed all variants
   │
   ▼
for each variant embedding:
    vectorStore.search(emb, topK)           ← cosine similarity + source boost
merge: keep highest score per chunk id
   │
   ▼
top K chunks → format as context → GPT-4 answer with citations
```

The **multi-query merge** uses *max score* across variants, not sum or average. This biases toward "if any phrasing of the question matches well, surface it" rather than requiring agreement across variants. Recall-friendly.

---

## Vector store

In-memory `VectorEntry[]`, persisted to a single JSON file with atomic write (temp + rename).

```ts
interface VectorEntry {
  id: string;
  content: string;              // chunk text (≤ 3000 chars)
  embedding: number[];          // 1536 dims (text-embedding-3-small)
  metadata: {
    sourceType: 'km_system' | 'google_docs' | 'notion' | 'personal_publish';
    sourceId: string;
    title: string;
    description: string;        // platform-specific deep-link target
    path: string;
    category: string;
    chunkIndex: number;
    updatedAt: string;
  };
}
```

### Why not a real vector DB?

For the production workload (~6,000 chunks, 30 users, 5–10 queries/min peak):

| Approach | Pros | Cons |
|---|---|---|
| In-memory + JSON | Zero infra, simple, fast (~5ms per search) | Doesn't scale past ~50k chunks (memory + load time) |
| Qdrant / Pinecone | Scales, persistent, filtering | Adds infra, latency, monthly cost |

In-memory wins until ~50k chunks. Adding a vector DB at that point is a clean migration: the same metadata + embedding shape, just call a different `search()`.

---

## Sync pipeline

```
hourly cron / startup catchup
   │
   ▼
syncKnowledgeBase(lastSyncTime?)
   │
   ├─→ extractWikiJsPages(lastSyncTime)        ← SELECT WHERE updatedAt > ?
   ├─→ extractGoogleDocs(lastSyncTime)         ← Drive API + mammoth for .docx
   └─→ extractNotion(lastSyncTime)             ← Search API, filter by status
   │
   ▼
chunkPage (## heading aware, then paragraph fallback)
   │
   ▼
embedBatch (Azure OpenAI, 100 chunks per call)
   │
   ▼
upsert into vector store
   │
   ▼
save() → write to JSON via temp + rename
   │
   ▼
setLastSyncAt(now)
```

### Incremental sync correctness

Each source applies `updatedAt > lastSyncTime` server-side. Returned chunks **replace** existing entries for their `sourceId` (deleteBySource + upsert). Unchanged docs are untouched.

Critical edge case discovered in production: an early version cleared ALL entries of a `sourceType` on each incremental sync. Result: one Wiki.js page edit deleted all 800 Notion entries. Current code only deletes the specific `sourceId`s present in the new batch.

---

## Persistence

What needs to survive deploys / restarts:

| Data | File | Notes |
|---|---|---|
| Vector embeddings | `vector-store.json` | Largest; ~150 MB for 6k chunks |
| Last sync time | `sync-state.json` | Saves a full re-embed on every restart |
| Last reminder fire | `daily-reminder-state.json` | Powers the polling-based reminder safety net |
| User notes / reminders | `data/personal/<user-id>.json` | One file per user |
| Teams ConversationReferences | `conversation-refs.json` | Needed for proactive (push) messages |
| Edit session state | `edit-sessions.json` | Multi-step edit flow survives restarts |

**On Azure App Service**, all of these MUST be under `C:\home\data\` (Windows) or `/home/data/` (Linux). The default `wwwroot/data/` is wiped on every zip deploy.

---

## Self-healing for unreliable infrastructure

### Daily reminder cron — polling safety net

`node-cron` schedules can silently die in long-running Node processes. The hourly `0 9,14,17` schedule missed multiple days in production while `*/5` schedules stayed healthy.

Current design: keep the cron AND run a 10-minute polling loop that:

1. Reads `daily-reminder-state.json` for `lastFiredAt`.
2. Computes `mostRecentScheduledFireBefore(now)` for the configured cron.
3. If `lastFiredAt < mostRecentScheduledFire`, fire now (capped at 4-hour grace to avoid spamming on a Monday morning startup).
4. Pushing updates `lastFiredAt`.

This makes the daily reminder resilient to `node-cron` dying, process restarts at the cron moment, and the 1-hour delay before `setInterval` first fires after a restart.

### Sync catchup on startup

Same pattern: on startup, if `now - lastSyncAt > 70 minutes`, kick off an incremental sync immediately rather than waiting for the next hourly fire.

---

## Image handling

```
user uploads image via Teams
   │
   ▼
context.activity.attachments → handleImageUpload
   │
   ├─ Get Bot Framework Bearer token (MicrosoftAppCredentials.getToken)
   ├─ Fetch image bytes from contentUrl with Authorization header
   ├─ Detect actual mime via magic-byte sniff (Teams sends image/* wildcard)
   ├─ Upload to private Azure Blob with UUID name
   ▼
Attach blob name to note/reminder JSON
   │
   ▼
on render → generateSasUrl (60-min validity) → Adaptive Card Image element
```

When user publishes a note with images to KM or Google Docs:
- **KM**: read blob, base64-encode, embed inline in markdown. Self-contained.
- **Google Docs**: short-lived (5 min) SAS URL → `insertInlineImage` request. Docs server fetches and stores its own copy. The SAS expires but Docs already has the bytes.

After publish, the original blob is deleted (the target platform now owns the canonical copy).

---

## Edit flow

The multi-step edit/append flow needs to survive a process restart between user clicks. The session state is persisted:

```
user: "#edit replace 'X' with 'Y'"
   │
   ▼
parseEditIntent → optional GPT clarification
   │
   ▼
searchDocumentsContaining('X') → candidates: [doc1, doc2, ...]
   │
   ▼
Adaptive Card "edit preview" with one Approve/Skip button per doc
   │
   │ ← writes editSessions.json with session_id → candidates → decisions
   │
   ▼
user clicks Approve on doc1
   │
   ▼
load session → resolve doc1 metadata → call source-specific edit (KM / GDocs / Notion)
   │
   ├─ Wiki.js GraphQL update
   ├─ Google Docs batchUpdate (DWD impersonation)
   └─ Notion blocks.update + audit annotation
```

Each source has different API quirks. The unifying contract: given `oldText`, `newText`, return `{success, error?}`.

---

## Where to extend

The architecture is intentionally seam-y in three places:

1. **Knowledge sources** — adding a 4th source (Confluence, GitHub wikis, SharePoint, etc.) means writing one `extractFoo(lastSyncTime): PageRecord[]` function and registering it in `etl/sync.ts`. Everything downstream (chunking, embedding, search) is source-agnostic.

2. **LLM provider** — `services/embedding.ts` and `services/claude.ts` are the only two files that import an LLM SDK. Both could move behind a thin interface for provider swapping.

3. **Output channels** — currently only Microsoft Teams. The RAG pipeline doesn't know about Teams. The same `ragQuery` powers `/api/chat` and the Teams handler; a Slack adapter or REST integration drops in cleanly.
