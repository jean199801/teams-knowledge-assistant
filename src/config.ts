import path from 'path';

// Default system prompt — can override via BOT_SYSTEM_PROMPT env var.
// {context} placeholder will be replaced with retrieved knowledge chunks.
const DEFAULT_SYSTEM_PROMPT = `You are a knowledge assistant for the team's internal documentation.

Rules:
1. Answer only based on the knowledge base content provided below. Do not make up information.
2. If the knowledge base doesn't contain the answer, clearly say so and suggest contacting the relevant department.
3. Be concise and clear. Match the user's language (auto-detect from the question).
4. If the question is about a procedure, use numbered steps.
5. If the topic is a known issue/bug, mention current status (fixed / pending) and any workaround.
6. End your answer with the source document titles.

Knowledge base content:
---
{context}
---`;

export const config = {
  // Branding (shown in startup banner)
  botDisplayName: process.env.BOT_DISPLAY_NAME || 'Teams Knowledge Assistant',

  // AI - Azure OpenAI
  azureOpenai: {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    apiKey: process.env.AZURE_OPENAI_API_KEY || '',
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview',
  },
  chatModel: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4.1',
  embeddingModel: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small',
  embeddingDimension: 1536,

  // Optional: direct OpenAI / Anthropic (currently unused; included for future swap)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  claudeModel: 'claude-sonnet-4-5-20250514',

  // Wiki.js / KM database (Azure SQL)
  kmDb: {
    server: process.env.KM_DB_SERVER || '',
    database: process.env.KM_DB_NAME || 'wiki',
    user: process.env.KM_DB_USER || '',
    password: process.env.KM_DB_PASSWORD || '',
    authType: process.env.KM_DB_AUTH_TYPE || 'sql', // 'sql' | 'azure-ad'
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  },

  // Teams Bot
  teams: {
    appId: process.env.MICROSOFT_APP_ID || '',
    appPassword: process.env.MICROSOFT_APP_PASSWORD || '',
    appTenantId: process.env.MICROSOFT_APP_TENANT_ID || '',
  },

  // Server
  port: parseInt(process.env.HTTP_PLATFORM_PORT || process.env.PORT || '3200', 10),
  syncSecret: process.env.SYNC_SECRET || 'change-me-in-production',

  // ETL
  etl: {
    // KM category filter (empty = sync all published pages)
    categories: [] as string[],
    chunkMaxLength: 500, // characters per chunk
  },

  // RAG
  rag: {
    topK: parseInt(process.env.RAG_TOP_K || '5', 10),
    // Source priority boost added to cosine similarity score.
    // Tune by use case — e.g. if Notion holds the freshest docs, boost it higher.
    sourceBoost: {
      notion: parseFloat(process.env.RAG_BOOST_NOTION || '0.05'),
      google_docs: parseFloat(process.env.RAG_BOOST_GOOGLE_DOCS || '0.03'),
      km_system: parseFloat(process.env.RAG_BOOST_KM || '0'),
    } as Record<string, number>,
    systemPrompt: process.env.BOT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
  },

  // Google Docs (optional source)
  googleDocs: {
    serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || '',
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    enabled: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
  },

  // Notion (optional source)
  notion: {
    apiKey: process.env.NOTION_API_KEY || '',
    enabled: !!process.env.NOTION_API_KEY,
    // Only sync pages matching these status values (empty = no filter)
    statusFilter: process.env.NOTION_STATUS_FILTER
      ? process.env.NOTION_STATUS_FILTER.split(',').map((s) => s.trim())
      : [],
  },

  // KM (Wiki.js) base URL for generating source links
  kmBaseUrl: process.env.KM_BASE_URL || '',

  // Wiki.js GraphQL API (for write-back: edit / append / publish)
  wikijs: {
    apiUrl: process.env.WIKIJS_API_URL || '',
    apiToken: process.env.WIKIJS_API_TOKEN || '',
  },

  // Data paths
  dataDir: path.join(__dirname, '..', 'data'),
  // ⚠️ vector-store.json must live OUTSIDE the deploy target on cloud (e.g. Azure App Service:
  // use D:\home\data\ instead of wwwroot/data/). Otherwise zip-deploy wipes the embeddings
  // and the bot stops answering until the next full sync completes.
  vectorStorePath: process.env.VECTOR_STORE_PATH || path.join(__dirname, '..', 'data', 'vector-store.json'),

  // lastSyncTime persistence — survives restarts so we can do incremental sync, not full re-embed
  syncStatePath: process.env.SYNC_STATE_PATH || path.join(__dirname, '..', 'data', 'sync-state.json'),

  // Azure Blob Storage (for user-uploaded images attached to notes/reminders)
  blobStorage: {
    connectionString: process.env.AZURE_BLOB_CONNECTION_STRING || '',
    containerName: process.env.AZURE_BLOB_CONTAINER_NAME || 'note-images',
    sasDurationMinutes: parseInt(process.env.AZURE_BLOB_SAS_DURATION_MINUTES || '60', 10),
    maxFileSizeBytes: 5 * 1024 * 1024,    // 5 MB per image
    maxImagesPerItem: 5,                  // 5 images per note/reminder
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  },

  // Personal assistant (notes / reminders / publish)
  // ⚠️ On cloud deployments these paths MUST point to a persistent location, not the
  // deploy target. Otherwise zip-deploy wipes user notes, reminders, and edit sessions.
  personalAssistant: {
    dataDir: process.env.PERSONAL_DATA_DIR || path.join(__dirname, '..', 'data', 'personal'),
    conversationRefsPath: process.env.PERSONAL_CONV_REFS_PATH || path.join(__dirname, '..', 'data', 'conversation-refs.json'),
    editSessionsPath: process.env.EDIT_SESSIONS_PATH || path.join(__dirname, '..', 'data', 'edit-sessions.json'),
    dailyReminderCron: process.env.DAILY_REMINDER_CRON || '0 9 * * 1-5', // Mon-Fri 09:00 local time
    dailyReminderStatePath: process.env.DAILY_REMINDER_STATE_PATH || path.join(__dirname, '..', 'data', 'daily-reminder-state.json'),
    defaultPublishTarget: (process.env.DEFAULT_PUBLISH_TARGET || 'km') as 'km' | 'gdocs',
    notionPublishParentPageId: process.env.NOTION_PUBLISH_PARENT_PAGE_ID || '',
    googleDocsPublishFolderId: process.env.GOOGLE_DOCS_PUBLISH_FOLDER_ID || '',
  },
};
