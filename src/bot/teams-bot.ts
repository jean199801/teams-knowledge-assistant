import {
  TurnContext,
  MessageFactory,
  CardFactory,
  TeamsActivityHandler,
  TeamsInfo,
  AdaptiveCardInvokeResponse,
  AdaptiveCardInvokeValue,
} from 'botbuilder';
import { MicrosoftAppCredentials } from 'botframework-connector';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { ragQuery, RagResponse } from '../services/rag';
import { createAnswerCard, createErrorCard, createWelcomeCard } from './adaptive-cards';
import {
  parseCommand,
  handleCommand,
  classifyIntent,
  handleIntent,
  suggestPublishLocation,
  suggestPublishTarget,
  parseEditIntent,
  structureNoteForPublish,
  extractDate,
} from '../services/personal-assistant';
import * as store from '../services/personal-store';
import {
  publishNote,
  listKmCategories,
  listGoogleDocsFolders,
} from '../services/publish';
import { saveConversationRef } from './proactive';
import {
  createInputPromptCard,
  createReminderListCard,
  createNoteListCard,
  createReminderCompletedCard,
  createPublishLocationCard,
  createPublishSuccessCard,
  createHelpCard,
  createPlatformPickerCard,
  createDeleteNoteConfirmCard,
  createNoteConfirmCard,
  createReminderConfirmCard,
  createPrivateChatRedirectCard,
  createImageAttachedCard,
  createPublishSuggestionCard,
} from './personal-cards';
import { uploadImage as blobUploadImage, deleteImages as blobDeleteImages, detectImageMimeType } from '../services/blob-storage';
import {
  searchDocumentsContaining,
  searchDocumentsByTitle,
  getCandidatesBySourceIds,
  editGoogleDoc,
  editKmPage,
  editNotionPage,
  appendToGoogleDoc,
  appendToKmPage,
  appendToNotionPage,
  resyncEditedDocument,
  EditCandidate,
} from '../services/kb-edit';
import { addEditLog, EditDocResult } from '../services/edit-log';
import {
  createEditPreviewCard,
  createEditResultCard,
  createEditNoMatchCard,
  createAppendPreviewCard,
  createAppendSuccessCard,
} from './edit-cards';
import { trackEvent, trackException } from '../services/telemetry';

// ── 修改流程 Session 管理 ──
//
// Session 必須持久化到磁碟，原因：App Service Plan 上可能有多台 instance，
// 顯示卡片的請求可能落在 A 機、按鈕回 callback 可能落在 B 機。
// Azure App Service 的 wwwroot (data/) 是跨 instance 共用的 shared storage，
// 所以用一個 JSON 檔就能在兩台 instance 之間共享 session 狀態。

interface EditSession {
  oldText: string;
  newText: string;
  candidates: EditCandidate[];
  decisions: Map<string, EditDocResult>; // sourceId → result
  userId: string;
  userName: string;
  createdAt: number;
}

interface SerializedSession {
  oldText: string;
  newText: string;
  candidates: EditCandidate[];
  decisions: Array<[string, EditDocResult]>;
  userId: string;
  userName: string;
  createdAt: number;
}

const EDIT_SESSIONS_FILE = config.personalAssistant.editSessionsPath;

function loadAllSessions(): Map<string, EditSession> {
  try {
    if (!fs.existsSync(EDIT_SESSIONS_FILE)) return new Map();
    const raw = fs.readFileSync(EDIT_SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, SerializedSession>;
    const result = new Map<string, EditSession>();
    for (const [id, s] of Object.entries(parsed)) {
      result.set(id, {
        oldText: s.oldText,
        newText: s.newText,
        candidates: s.candidates,
        decisions: new Map(s.decisions || []),
        userId: s.userId,
        userName: s.userName,
        createdAt: s.createdAt,
      });
    }
    return result;
  } catch (err: any) {
    console.error('[TeamsBot] 讀取 edit-sessions.json 失敗:', err.message);
    return new Map();
  }
}

function saveAllSessions(sessions: Map<string, EditSession>): void {
  try {
    const dir = path.dirname(EDIT_SESSIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, SerializedSession> = {};
    for (const [id, s] of sessions) {
      obj[id] = {
        oldText: s.oldText,
        newText: s.newText,
        candidates: s.candidates,
        decisions: Array.from(s.decisions.entries()),
        userId: s.userId,
        userName: s.userName,
        createdAt: s.createdAt,
      };
    }
    fs.writeFileSync(EDIT_SESSIONS_FILE, JSON.stringify(obj), 'utf-8');
  } catch (err: any) {
    console.error('[TeamsBot] 寫入 edit-sessions.json 失敗:', err.message);
  }
}

// 跨 instance 的 session 存取介面 — API 與原本的 Map 相容
const editSessions = {
  get(id: string): EditSession | undefined {
    return loadAllSessions().get(id);
  },
  set(id: string, session: EditSession): void {
    const all = loadAllSessions();
    all.set(id, session);
    saveAllSessions(all);
  },
  delete(id: string): void {
    const all = loadAllSessions();
    if (all.delete(id)) {
      saveAllSessions(all);
    }
  },
};

// 清理過期 session（30 分鐘）
function cleanExpiredSessions(): void {
  const all = loadAllSessions();
  const now = Date.now();
  let changed = false;
  for (const [id, session] of all) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      all.delete(id);
      changed = true;
    }
  }
  if (changed) saveAllSessions(all);
}

/**
 * 後勤知識助手 + 個人小助理 Teams Bot
 *
 * 支援：
 * - 1:1 私訊：個人助手（# 指令 + AI 意圖判斷）+ 知識庫查詢
 * - 群組 @mention：在頻道中 @後勤知識助手 提問（只走知識庫）
 */
export class KnowledgeAssistantBot extends TeamsActivityHandler {
  constructor() {
    super();

    // 收到訊息
    this.onMessage(async (context: TurnContext, next) => {
      const isGroupChat = context.activity.conversation?.conversationType !== 'personal';
      const isMentioned = this.isBotMentioned(context);

      // 群組/頻道中：只有被 @mention 才回答，否則忽略
      if (isGroupChat && !isMentioned) {
        await next();
        return;
      }

      // 1:1 私訊時儲存 ConversationReference（主動推送用）
      if (!isGroupChat) {
        saveConversationRef(context);
      }

      // ── 遙測：使用者送訊息事件 ──
      const attachmentCount = context.activity.attachments?.length || 0;
      const rawText = context.activity.text || '';
      trackEvent('BotMessageReceived', {
        userId: context.activity.from.id,
        userName: context.activity.from.name,
        conversationType: isGroupChat ? 'groupChat' : 'personal',
        hasCardAction: !!(context.activity.value && (context.activity.value as any).action),
        hasAttachment: attachmentCount > 0,
        textLength: rawText.length,
        commandPrefix: rawText.startsWith('#') || rawText.startsWith('/') ? rawText.slice(0, 6) : undefined,
      });

      // ── Adaptive Card 按鈕回調（Action.Submit 走 onMessage）──
      const cardData = context.activity.value;
      if (cardData && cardData.action) {
        console.log(`[TeamsBot] Card action (via onMessage): ${cardData.action}`, cardData);
        trackEvent('CardActionTriggered', {
          userId: context.activity.from.id,
          userName: context.activity.from.name,
          action: cardData.action,
          noteId: cardData.noteId,
          platform: cardData.platform,
        });
        try {
          await this.handleCardAction(context, cardData);
        } catch (error: any) {
          console.error('[TeamsBot] Card action 錯誤:', error.message);
          trackException(error, { action: cardData.action, userName: context.activity.from.name });
          await context.sendActivity(`處理操作時發生錯誤：${error.message}`);
        }
        await next();
        return;
      }

      // ── .md 檔案上傳偵測（只處理 1:1 私訊）──
      if (!isGroupChat && context.activity.attachments && context.activity.attachments.length > 0) {
        const mdAttachment = context.activity.attachments.find(
          (att: any) =>
            att.contentType === 'application/vnd.microsoft.teams.file.download.info' &&
            typeof att.name === 'string' &&
            att.name.toLowerCase().endsWith('.md'),
        );
        if (mdAttachment) {
          try {
            await this.handleMarkdownUpload(context, mdAttachment);
          } catch (error: any) {
            console.error('[TeamsBot] MD 檔案上傳處理失敗:', error.message);
            await context.sendActivity(`處理 Markdown 檔案時發生錯誤：${error.message}`);
          }
          await next();
          return;
        }
      }

      // ── 圖片附件偵測（只處理 1:1 私訊）──
      if (!isGroupChat && context.activity.attachments && context.activity.attachments.length > 0) {
        const imageAttachments = context.activity.attachments.filter((att: any) => {
          const ct = (att.contentType || '').toLowerCase();
          if (ct.startsWith('image/')) return true;
          // Teams 有時會用 file.download.info 包裝圖片
          if (ct === 'application/vnd.microsoft.teams.file.download.info' && typeof att.name === 'string') {
            return /\.(jpe?g|png|gif|webp)$/i.test(att.name);
          }
          return false;
        });
        if (imageAttachments.length > 0) {
          try {
            await this.handleImageUpload(context, imageAttachments);
          } catch (error: any) {
            console.error('[TeamsBot] 圖片上傳處理失敗:', error.message);
            await context.sendActivity(`處理圖片時發生錯誤：${error.message}`);
          }
          await next();
          return;
        }
      }

      // 移除 @mention 文字，取得純問題內容
      const question = this.removeMentionText(context);

      if (!question || question.trim().length === 0) {
        await context.sendActivity(
          '你好！我是**後勤知識助手**🤖\n\n' +
          '**知識庫查詢**：直接輸入問題（如：運費怎麼算？）\n' +
          '**個人小助理**：輸入 **#** 開啟指令選單\n\n' +
          '也可以直接問我「明天要完成什麼」查看個人待辦！',
        );
        await next();
        return;
      }

      console.log(`[TeamsBot] 收到訊息: ${question}`);

      // 顯示「正在輸入」提示
      await context.sendActivities([{ type: 'typing' }]);

      try {
        // ── 1:1 私訊：先檢查是否為 # 或 / 指令 ──
        if (!isGroupChat && (question.startsWith('#') || question.startsWith('/'))) {
          await this.handlePersonalCommand(context, question);
          await next();
          return;
        }

        // ── 1:1 私訊 + 非 # 指令：AI 判斷意圖 ──
        if (!isGroupChat) {
          const userId = context.activity.from.id;
          const userName = context.activity.from.name || '';
          await this.handlePersonalNaturalLanguage(context, question);
          await next();
          return;
        }

        // ── 群組 @mention：先 AI 判斷意圖，個人意圖 → 跳私訊提示，其他 → 走 RAG ──
        const userId = context.activity.from.id;
        const userName = context.activity.from.name || '';

        const intent = await classifyIntent(question, userId);
        console.log(`[TeamsBot] 群組意圖判斷: ${intent.type}`);
        trackEvent('GroupIntentClassified', { userName, intent: intent.type });

        // 個人意圖 → 回一張卡片引導到私訊處理
        const personalIntents = new Set([
          'add_reminder', 'save_note', 'query_reminders',
          'complete_reminder', 'search_personal', 'help',
        ]);
        if (personalIntents.has(intent.type)) {
          await context.sendActivity(
            MessageFactory.attachment(CardFactory.adaptiveCard(
              createPrivateChatRedirectCard(intent.type, question, config.teams.appId),
            )),
          );
        } else {
          // knowledge_query / edit_kb / greeting / 其他 → 全部當知識問題走 RAG
          const ragStart = Date.now();
          const result: RagResponse = await ragQuery(question);
          const ragMs = Date.now() - ragStart;
          console.log(`[TeamsBot] RAG 回答完成，參考 ${result.sources.length} 個來源, ${ragMs}ms`);
          trackEvent(
            'RagQueryCompleted',
            {
              userId,
              userName,
              question: question.slice(0, 200),
              sourceCount: result.sources.length,
              answerLength: result.answer?.length || 0,
            },
            { responseMs: ragMs },
          );

          // 記錄對話上下文（群組 @mention 的 RAG 也記，以便跨對話 resolve）
          this.saveLastRagContext(userId, userName, question, result);

          const card = createAnswerCard(question, result);
          await context.sendActivity(
            MessageFactory.attachment(CardFactory.adaptiveCard(card)),
          );
        }
      } catch (error: any) {
        console.error('[TeamsBot] 錯誤:', error.message);
        const errorCard = createErrorCard(error.message);
        await context.sendActivity(
          MessageFactory.attachment(CardFactory.adaptiveCard(errorCard)),
        );
      }

      await next();
    });

    // 新成員加入（包含 Bot 被加入對話時）
    this.onMembersAdded(async (context: TurnContext, next) => {
      const membersAdded = context.activity.membersAdded || [];

      for (const member of membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          const welcomeCard = createWelcomeCard();
          await context.sendActivity(
            MessageFactory.attachment(CardFactory.adaptiveCard(welcomeCard)),
          );
        }
      }

      await next();
    });
  }

  /**
   * 處理 Adaptive Card 按鈕回調
   */
  async onAdaptiveCardInvoke(context: TurnContext, _invokeValue: AdaptiveCardInvokeValue): Promise<AdaptiveCardInvokeResponse> {
    const data = context.activity.value?.action?.data || context.activity.value;
    const userId = context.activity.from.id;
    const userName = context.activity.from.name || '';

    console.log(`[TeamsBot] Card action: ${data?.action}`, data);

    try {
      switch (data?.action) {
        // ── 指令選單按鈕 ──
        case 'command_menu': {
          await this.handleMenuAction(context, userId, userName, data.command);
          break;
        }

        // ── 完成提醒按鈕 ──
        case 'complete_reminder': {
          await this.handleCompleteReminder(context, userId, data.reminderId);
          break;
        }

        // ── 從輸入卡片提交筆記/提醒 ──
        case 'submit_note': {
          await this.handleSubmitNote(context, userId, userName, data);
          break;
        }

        case 'submit_reminder': {
          await this.handleSubmitReminder(context, userId, userName, data);
          break;
        }

        // ── 取消輸入卡片（關閉原卡片） ──
        case 'cancel_input': {
          await this.replaceCardWithText(context, '✖️ 已取消');
          break;
        }

        // ── 發布：選擇平台 ──
        case 'publish_to': {
          await this.handlePublishPlatformSelected(context, userId, data.noteId, data.platform);
          break;
        }

        // ── 發布：從筆記列表點「發布」，顯示平台選擇卡片 ──
        case 'publish_select_platform': {
          await this.handlePublishSelectPlatform(context, userId, data.noteId);
          break;
        }

        // ── 發布：確認位置並執行（fire-and-forget 避免 invoke 15 秒 timeout）──
        case 'publish_confirm': {
          this.handlePublishConfirm(context, userId, userName, data.noteId, data.platform, data.locationId)
            .catch(async (error) => {
              console.error('[TeamsBot] publish_confirm 錯誤:', error.message);
              await context.sendActivity(`發布失敗：${error.message}`).catch(() => {});
            });
          break;
        }

        // ── 刪除筆記：顯示確認卡 ──
        case 'delete_note_ask': {
          await this.handleDeleteNoteAsk(context, userId, data.noteId);
          break;
        }

        // ── 刪除筆記：確認後執行 ──
        case 'delete_note_confirm': {
          await this.handleDeleteNoteConfirm(context, userId, data.noteId);
          break;
        }

        // ── 修改知識庫：確認/跳過單一文件（fire-and-forget 避免 invoke 15 秒 timeout）──
        case 'edit_document': {
          this.handleEditDocumentDecision(context, userId, userName, data)
            .catch(async (error) => {
              console.error('[TeamsBot] edit_document 錯誤:', error.message);
              await context.sendActivity(`修改失敗：${error.message}`).catch(() => {});
            });
          break;
        }

        // ── 附加內容：選擇目標文件（fire-and-forget）──
        case 'append_document': {
          this.handleAppendToDocument(context, userId, userName, data)
            .catch(async (error) => {
              console.error('[TeamsBot] append_document 錯誤:', error.message);
              await context.sendActivity(`附加失敗：${error.message}`).catch(() => {});
            });
          break;
        }
      }
    } catch (error: any) {
      console.error('[TeamsBot] Card action 錯誤:', error.message);
      await context.sendActivity(`處理操作時發生錯誤：${error.message}`);
    }

    return { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: { message: 'ok' } };
  }

  // ── 個人助手：自然語言處理（AI 分類意圖） ──

  /**
   * 用 AI 分類意圖後執行。
   * - add_reminder / save_note / query_reminders / complete_reminder / help / greeting → 直接回卡片
   * - edit_kb → 走知識庫修改流程（AI 再解析一次細節）
   * - knowledge_query → 走 RAG
   */
  private async handlePersonalNaturalLanguage(
    context: TurnContext,
    text: string,
  ): Promise<void> {
    const userId = context.activity.from.id;
    const userName = context.activity.from.name || '';

    let intent = await classifyIntent(text, userId);
    console.log(`[TeamsBot] 意圖判斷: ${intent.type}`);
    trackEvent('IntentClassified', { userName, intent: intent.type });

    // search_personal：先查個人筆記，若 0 結果 → 改走知識庫 RAG
    // 原因：GPT 意圖分類器常把「客訴消費金額比例」這類純名詞短句誤判成「搜尋個人筆記」，
    // 導致用戶以為 Bot 找不到公司知識。fallback 後個人筆記沒命中的問句會自動轉到 RAG。
    if (intent.type === 'search_personal') {
      const results = store.searchAll(userId, intent.keyword);
      if (results.length === 0) {
        console.log(`[TeamsBot] search_personal 找不到「${intent.keyword}」，fallback 走 RAG 查公司知識庫`);
        trackEvent('SearchPersonalFallbackToRag', { userName, keyword: intent.keyword });
        intent = { type: 'knowledge_query' } as any;
      }
    }

    // edit_kb：用 AI 進一步解析修改細節，進入修改流程
    if (intent.type === 'edit_kb') {
      const desc = (intent as any).description || text;
      await this.handleEditKbNaturalLanguage(context, userId, userName, desc);
      return;
    }

    // knowledge_query：走 RAG（交給呼叫端的主流程，這裡直接執行）
    if (intent.type === 'knowledge_query') {
      const ragStart = Date.now();
      const result: RagResponse = await ragQuery(text);
      const ragMs = Date.now() - ragStart;
      trackEvent('RagQueryCompleted', {
        userId,
        userName,
        question: text.slice(0, 200),
        sourceCount: result.sources.length,
        answerLength: result.answer?.length || 0,
      }, { responseMs: ragMs });

      // 記錄對話上下文，之後用戶說「這兩份」「那份」時能 resolve
      this.saveLastRagContext(userId, userName, text, result);

      await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(createAnswerCard(text, result))),
      );
      return;
    }

    // 其他個人意圖：走 handleIntent
    const result = await handleIntent(userId, userName, intent);
    if (result.card) {
      await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(result.card)),
      );
    } else if (result.text) {
      await context.sendActivity(result.text);
    }
  }

  // ── 個人助手：# 指令處理 ──

  private async handlePersonalCommand(context: TurnContext, text: string): Promise<void> {
    const userId = context.activity.from.id;
    const userName = context.activity.from.name || '';
    const command = parseCommand(text);

    // parseCommand 沒命中：把 `#` 去掉、丟給 AI 判斷意圖
    // 例如 `#明天下午兩點提醒我開會` → AI 判斷為 add_reminder → 直接新增
    if (!command) {
      const stripped = text.trim().replace(/^[#\/]\s*/, '');
      if (!stripped) {
        await context.sendActivity('無法辨識的指令。輸入 **#** 查看可用指令。');
        return;
      }
      console.log(`[TeamsBot] parseCommand 未命中，fallback 到 AI classifyIntent: ${stripped}`);
      await context.sendActivities([{ type: 'typing' }]);
      await this.handlePersonalNaturalLanguage(context, stripped);
      return;
    }

    // 發布指令需要特殊處理（兩階段流程）
    if (command.type === 'publish' && command.id && command.platform) {
      await this.handlePublishPlatformSelected(context, userId, command.id, command.platform);
      return;
    }

    // 修改知識庫指令
    if (command.type === 'edit_kb') {
      if (command.oldText && command.newText) {
        // 快速格式：已解析出 oldText 和 newText
        await this.handleEditKbStart(context, userId, userName, command.oldText, command.newText);
      } else if (command.content) {
        // 自然語言格式：需要 AI 解析
        await this.handleEditKbNaturalLanguage(context, userId, userName, command.content);
      }
      return;
    }

    const result = await handleCommand(userId, userName, command);

    if (result.card) {
      await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(result.card)),
      );
    } else if (result.text) {
      await context.sendActivity(result.text);
    }
  }

  // ── 指令選單動作 ──

  private async handleMenuAction(
    context: TurnContext,
    userId: string,
    userName: string,
    command: string,
  ): Promise<void> {
    switch (command) {
      case 'note_prompt':
        await context.sendActivity(
          MessageFactory.attachment(
            CardFactory.adaptiveCard(createInputPromptCard('note')),
          ),
        );
        break;

      case 'reminder_prompt':
        await context.sendActivity(
          MessageFactory.attachment(
            CardFactory.adaptiveCard(createInputPromptCard('reminder')),
          ),
        );
        break;

      case 'complete_list': {
        const reminders = store.listPendingReminders(userId);
        await context.sendActivity(
          MessageFactory.attachment(
            CardFactory.adaptiveCard(createReminderListCard(reminders)),
          ),
        );
        break;
      }

      case 'note_list': {
        const notes = store.listNotes(userId);
        await context.sendActivity(
          MessageFactory.attachment(
            CardFactory.adaptiveCard(createNoteListCard(notes)),
          ),
        );
        break;
      }

      case 'publish_list': {
        const notes = store.listNotes(userId);
        if (notes.length === 0) {
          await context.sendActivity('還沒有筆記可以發布。先用 **#記** 記錄一些內容吧！');
        } else {
          await context.sendActivity(
            MessageFactory.attachment(
              CardFactory.adaptiveCard(createNoteListCard(notes)),
            ),
          );
          await context.sendActivity('輸入 **#發布 編號** 來發布筆記，例如：`#發布 1`');
        }
        break;
      }

      case 'help':
        await context.sendActivity(
          MessageFactory.attachment(CardFactory.adaptiveCard(createHelpCard())),
        );
        break;
    }
  }

  // ── 發布流程 ──

  /**
   * 第二階段：用戶選定平台後，AI 建議位置
   */
  private async handlePublishPlatformSelected(
    context: TurnContext,
    userId: string,
    noteId: number,
    platform: string,
  ): Promise<void> {
    const note = store.getNote(userId, noteId);
    if (!note) {
      await context.sendActivity(`找不到筆記 #${noteId}`);
      return;
    }

    // Notion 不支援個人筆記發布（只能修改既有頁面）
    if (platform === 'notion') {
      await context.sendActivity('Notion 不支援從個人筆記建立新頁面，請改選 KM 或 Google Docs。若要修改現有 Notion 頁面，請使用 `#修改` 或 `#追加`。');
      return;
    }

    await context.sendActivities([{ type: 'typing' }]);

    // 取得平台的可用位置
    let locations: Array<{ id: string; name: string }> = [];
    switch (platform) {
      case 'km':
        locations = await listKmCategories();
        break;
      case 'gdocs':
        locations = await listGoogleDocsFolders();
        break;
    }

    if (locations.length === 0) {
      // 找不到位置，直接用預設發布
      await this.handlePublishConfirm(
        context,
        userId,
        context.activity.from.name || '',
        noteId,
        platform,
        undefined,
      );
      return;
    }

    // AI 建議位置
    const suggestion = await suggestPublishLocation(note.content, platform, locations);

    const card = createPublishLocationCard(
      noteId,
      platform,
      locations,
      suggestion.locationId,
      suggestion.reason,
    );

    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
    );
  }

  /**
   * 第三階段：確認位置並執行發布
   */
  private async handlePublishConfirm(
    context: TurnContext,
    userId: string,
    userName: string,
    noteId: number,
    platform: string,
    locationId: string | undefined,
  ): Promise<void> {
    const note = store.getNote(userId, noteId);
    if (!note) {
      await context.sendActivity(`找不到筆記 #${noteId}`);
      return;
    }

    // 先立刻回覆一則訊息讓 Teams 知道 card action 已被接收，避免「發生問題」error banner
    const images = note.images || [];
    const imageTip = images.length > 0 ? `（含 ${images.length} 張圖）` : '';
    await context.sendActivity(`⏳ 正在發布到 ${platform}...${imageTip}`);
    await context.sendActivities([{ type: 'typing' }]);

    // AI 自動整理標題與內文（失敗時 fallback 為截斷行為）
    let structured: { title: string; content: string };
    try {
      structured = await structureNoteForPublish(note.content);
    } catch (err: any) {
      console.error('[TeamsBot] AI 整理筆記失敗，改用原始內容:', err.message);
      structured = {
        title: note.content.length > 30 ? note.content.slice(0, 30) + '...' : note.content,
        content: note.content,
      };
    }

    await context.sendActivity(`📝 標題：${structured.title}`);

    // 取得 Teams 用戶 email（優先用 email 對應 Wiki.js 使用者，避免重名）
    const userEmail = await this.getUserEmail(context);

    const result = await publishNote(
      platform,
      structured.title,
      structured.content,
      userEmail || userName,
      noteId,
      locationId,
      userEmail,  // Google Docs DWD 需要（用戶的 Workspace email）
      images,
    );

    // 發布成功 → 從筆記移除 images 欄位（Blob 已在 publishNote 內清除）
    if (result.success && images.length > 0) {
      store.clearNoteImages(userId, noteId);
    }

    if (result.success) {
      store.markNotePublished(userId, noteId, platform);
      trackEvent('NotePublished', {
        userId,
        userName,
        platform,
        noteId,
        title: structured.title,
        contentLength: structured.content.length,
        url: result.url,
      });
      await context.sendActivity(
        MessageFactory.attachment(
          CardFactory.adaptiveCard(
            createPublishSuccessCard(platform, structured.title, result.url, images.length),
          ),
        ),
      );
    } else {
      trackEvent('NotePublishFailed', {
        userId,
        userName,
        platform,
        noteId,
        error: result.error,
      });
      await context.sendActivity(`發布失敗：${result.error}`);
    }
  }

  /**
   * 處理用戶上傳的 .md 檔：下載 → 存為筆記 → 顯示平台選擇卡片
   */
  private async handleMarkdownUpload(
    context: TurnContext,
    attachment: any,
  ): Promise<void> {
    const userId = context.activity.from.id;
    const userName = context.activity.from.name || '';
    const filename = attachment.name || 'upload.md';

    await context.sendActivities([{ type: 'typing' }]);

    const downloadUrl: string | undefined = attachment.content?.downloadUrl;
    if (!downloadUrl) {
      await context.sendActivity('無法取得檔案下載連結，請重新上傳。');
      return;
    }

    // 下載檔案（15 秒 timeout，30KB 大小上限）
    const MAX_BYTES = 30 * 1024;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let text: string;
    try {
      const res = await fetch(downloadUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        await context.sendActivity(`檔案下載失敗（HTTP ${res.status}），請稍後再試。`);
        return;
      }

      const contentLength = Number(res.headers.get('content-length') || 0);
      if (contentLength > 0 && contentLength > MAX_BYTES) {
        await context.sendActivity(
          `檔案過大（${(contentLength / 1024).toFixed(1)} KB），請控制在 30 KB 以內。`,
        );
        return;
      }

      text = await res.text();
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        await context.sendActivity('檔案下載逾時（超過 15 秒），請稍後再試。');
      } else {
        await context.sendActivity(`檔案下載失敗：${error.message}`);
      }
      return;
    }

    // 後端大小驗證（有些檔案沒給 content-length）
    const byteLen = Buffer.byteLength(text, 'utf-8');
    if (byteLen > MAX_BYTES) {
      await context.sendActivity(
        `檔案過大（${(byteLen / 1024).toFixed(1)} KB），請控制在 30 KB 以內。`,
      );
      return;
    }

    // 內容檢查
    if (text.includes('\0')) {
      await context.sendActivity('檔案內容包含不合法字元，可能不是純文字檔。');
      return;
    }
    if (!text.trim()) {
      await context.sendActivity('檔案內容為空，無法發布。');
      return;
    }

    // 存為筆記，走既有的發布流程
    const note = store.addNote(userId, userName, text);
    console.log(`[TeamsBot] MD 檔案上傳: ${filename}, ${text.length} 字元, noteId=${note.id}`);

    const preview = text.length > 80 ? text.slice(0, 80).replace(/\n/g, ' ') + '...' : text;
    const card = createPlatformPickerCard(
      note.id,
      `📄 **${filename}** (#${note.id}, ${text.length} 字元)\n\n${preview}`,
      '📤 已收到 Markdown 檔案，請選擇發布平台（發布時會由 AI 自動整理標題與排版）',
    );

    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
    );
  }

  /**
   * 處理用戶上傳的圖片附件
   * 策略：
   *   - 每張圖下載 → 驗證 → 上傳到 Blob
   *   - 若 activity 還有文字 → 以文字建立新筆記，把圖片掛上去
   *   - 若只有圖片 → 附到最近 5 分鐘內的未發布筆記 / 未完成提醒（以最新的優先）
   *   - 都沒有 → 建立一則「📸 圖片筆記」預設筆記
   */
  private async handleImageUpload(
    context: TurnContext,
    attachments: any[],
  ): Promise<void> {
    const userId = context.activity.from.id;
    const userName = context.activity.from.name || '';
    const userText = (this.removeMentionText(context) || '').trim();
    console.log(`[TeamsBot] handleImageUpload userText=${JSON.stringify(userText)} attachments=${attachments.length}`);

    await context.sendActivities([{ type: 'typing' }]);

    const MAX_PER_MSG = 5;
    const toProcess = attachments.slice(0, MAX_PER_MSG);
    if (attachments.length > MAX_PER_MSG) {
      await context.sendActivity(`⚠️ 單次最多處理 ${MAX_PER_MSG} 張圖，其他略過。`);
    }

    const uploaded: import('../services/personal-store').BlobImage[] = [];
    const errors: string[] = [];

    // 預先取得 Bot Framework bearer token（image/* attachment 的 contentUrl 需要 Bearer 驗證）
    let botFrameworkToken: string | undefined;
    let tokenAttemptFailed = false;
    const serviceUrl = context.activity.serviceUrl;
    const getBotToken = async (): Promise<string | undefined> => {
      if (botFrameworkToken) return botFrameworkToken;
      if (tokenAttemptFailed) return undefined;
      try {
        if (serviceUrl) MicrosoftAppCredentials.trustServiceUrl(serviceUrl);
        const credentials = new MicrosoftAppCredentials(config.teams.appId, config.teams.appPassword);
        botFrameworkToken = await credentials.getToken();
        return botFrameworkToken;
      } catch (err: any) {
        console.error('[TeamsBot] 無法取得 Bot Framework token:', err.message);
        tokenAttemptFailed = true;
        return undefined;
      }
    };

    for (const att of toProcess) {
      try {
        // 兩種 attachment 型別，取下載 URL + contentType
        let downloadUrl: string | undefined;
        let declaredContentType: string | undefined;
        let needAuth = false; // contentUrl 需要 Bearer token，file.download.info 的 downloadUrl 是 pre-signed

        if ((att.contentType || '').toLowerCase().startsWith('image/')) {
          downloadUrl = att.contentUrl;
          declaredContentType = att.contentType;
          needAuth = true;
        } else if (att.contentType === 'application/vnd.microsoft.teams.file.download.info') {
          downloadUrl = att.content?.downloadUrl;
          const ext = (att.name || '').split('.').pop()?.toLowerCase();
          declaredContentType = ext === 'png' ? 'image/png'
            : ext === 'gif' ? 'image/gif'
            : ext === 'webp' ? 'image/webp'
            : 'image/jpeg';
        }

        if (!downloadUrl) {
          errors.push('無法取得下載連結');
          continue;
        }

        // 準備 headers（若是 Bot Framework 保護的 URL 需要帶 Bearer token）
        const headers: Record<string, string> = {};
        if (needAuth) {
          const token = await getBotToken();
          if (token) headers['Authorization'] = `Bearer ${token}`;
        }

        // 下載（15s timeout，由 fetch 限制 body size 用手動 check）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        let res = await fetch(downloadUrl, { signal: controller.signal, headers });

        // 401：token 可能有變或沒帶到，重拿 token 再試一次
        if (res.status === 401 && needAuth) {
          botFrameworkToken = undefined;
          const token = await getBotToken();
          if (token) {
            res = await fetch(downloadUrl, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } });
          }
        }

        clearTimeout(timeoutId);

        if (!res.ok) {
          errors.push(`下載失敗 HTTP ${res.status}`);
          continue;
        }

        // data: URI 形式也要處理（某些客戶端會直接把 base64 塞 contentUrl）
        const ab = await res.arrayBuffer();
        const data = Buffer.from(ab);

        // 判斷實際格式的優先順序：
        //   1. magic bytes（最可靠）
        //   2. response 的 content-type header（若是具體 image/xxx）
        //   3. 宣告的 attachment.contentType（若是具體 image/xxx）
        //   4. 預設 jpeg
        const respCt = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const magicType = detectImageMimeType(data);
        const specificSpecs = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        let contentType = magicType
          || (specificSpecs.includes(respCt) ? respCt : undefined)
          || (declaredContentType && specificSpecs.includes(declaredContentType.toLowerCase()) ? declaredContentType.toLowerCase() : undefined)
          || 'image/jpeg';

        const blob = await blobUploadImage(userId, data, contentType);
        uploaded.push({
          blobName: blob.blobName,
          contentType: blob.contentType,
          uploadedAt: new Date().toISOString(),
          size: blob.size,
        });
      } catch (err: any) {
        errors.push(err.message || String(err));
      }
    }

    if (uploaded.length === 0) {
      await context.sendActivity(`❌ 所有圖片都上傳失敗：\n${errors.map((e) => `• ${e}`).join('\n')}`);
      return;
    }

    // 決定要掛到哪一則（預設為筆記，兩個 branch 都一定會重新賦值）
    let targetType: 'note' | 'reminder' = 'note';
    let targetItem: { id: number; content: string } = { id: 0, content: '' };

    if (userText) {
      // 「發布」開頭 → 直接發布模式：存為筆記 + 附圖 + 顯示平台建議卡（跟 #發布 X 一致）
      const publishPrefixMatch = userText.match(/^#?\s*發布[：:，,\s]*(.+)/s);
      if (publishPrefixMatch) {
        const content = publishPrefixMatch[1].trim();
        const note = store.addNote(userId, userName, content);
        const attachResult = store.attachImages(userId, 'note', note.id, uploaded);
        if (!attachResult.success) {
          await context.sendActivity(`⚠️ ${attachResult.error}`);
          return;
        }
        const suggestion = await suggestPublishTarget(content);
        const preview = content.length > 50 ? content.slice(0, 50) + '...' : content;
        const imageNote = `（含 ${uploaded.length} 張圖）`;
        await context.sendActivity(`📝 已存為筆記 #${note.id}${imageNote}，請選擇發布平台：`);
        await context.sendActivity(
          MessageFactory.attachment(
            CardFactory.adaptiveCard(createPublishSuggestionCard(note.id, preview, suggestion)),
          ),
        );
        return;
      }

      // 有文字 → 跟沒附圖一致：用 GPT 判斷意圖（筆記 vs 提醒）
      // 若以「提醒」開頭 → 直接走 reminder 快速路徑，省一次 GPT 呼叫
      const reminderPrefixMatch = userText.match(/^提醒[：:，,\s]*(.+)/s);
      if (reminderPrefixMatch) {
        const rest = reminderPrefixMatch[1].trim();
        const { content, dueDate, dueTime } = extractDate(rest);
        const reminder = store.addReminder(userId, userName, content, dueDate, dueTime);
        targetType = 'reminder';
        targetItem = { id: reminder.id, content: reminder.content };
      } else {
        // GPT 意圖分類，若判斷失敗就 fallback 建筆記
        let intentHandled = false;
        try {
          const intent = await classifyIntent(userText, userId);
          if (intent.type === 'add_reminder') {
            const reminder = store.addReminder(userId, userName, intent.content, intent.dueDate, intent.dueTime);
            targetType = 'reminder';
            targetItem = { id: reminder.id, content: reminder.content };
            intentHandled = true;
          } else if (intent.type === 'save_note') {
            const note = store.addNote(userId, userName, intent.content || userText);
            targetType = 'note';
            targetItem = { id: note.id, content: note.content };
            intentHandled = true;
          }
          // 其他意圖（query_reminders / greeting / knowledge_query 等）→ fallback 建筆記
        } catch (err: any) {
          console.error('[TeamsBot] handleImageUpload classifyIntent 失敗，fallback 建筆記:', err.message);
        }
        if (!intentHandled) {
          const note = store.addNote(userId, userName, userText);
          targetType = 'note';
          targetItem = { id: note.id, content: note.content };
        }
      }
    } else {
      const recentReminder = store.getLatestRecentReminder(userId);
      const recentNote = store.getLatestRecentNote(userId);
      // 以最新的優先（createdAt 比較）
      const rcAt = recentReminder ? new Date(recentReminder.createdAt).getTime() : 0;
      const ncAt = recentNote ? new Date(recentNote.createdAt).getTime() : 0;
      if (recentReminder && rcAt >= ncAt) {
        targetType = 'reminder';
        targetItem = { id: recentReminder.id, content: recentReminder.content };
      } else if (recentNote) {
        targetType = 'note';
        targetItem = { id: recentNote.id, content: recentNote.content };
      } else {
        // 完全沒有最近項目 → 建預設圖片筆記
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const note = store.addNote(userId, userName, `📸 圖片筆記 ${stamp}`);
        targetType = 'note';
        targetItem = { id: note.id, content: note.content };
      }
    }

    const attachResult = store.attachImages(userId, targetType, targetItem.id, uploaded);
    if (!attachResult.success) {
      // 超過上限 → 告知並（不回滾 Blob，先保留以便使用者可以用後續指令處理）
      await context.sendActivity(`⚠️ ${attachResult.error}\n已上傳的圖片暫時保留，請先刪除/發布該${targetType === 'note' ? '筆記' : '提醒'}的舊圖再試。`);
      return;
    }

    const card = createImageAttachedCard(
      targetType,
      targetItem.id,
      targetItem.content,
      uploaded,
      attachResult.totalCount,
      errors,
    );
    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
    );
  }

  // ── 輸入卡片 submit / cancel / 清空 ──

  /**
   * 把使用者剛點擊的原卡片，用 updateActivity 替換成一張簡單的文字卡片。
   * 用途：清掉輸入框、顯示「已取消 / 已記錄」等結果。
   * 若 replyToId 不存在（非 card callback 情境），退而求其次用 sendActivity。
   */
  /**
   * 把 RAG 回答的 sources 保存成對話上下文，供之後「這份」「那兩份」等代名詞解析使用。
   * 去重：同一文件（同 sourceType + sourceId）只保留一筆。
   */
  private saveLastRagContext(
    userId: string,
    userName: string,
    question: string,
    ragResult: RagResponse,
  ): void {
    const seen = new Set<string>();
    const uniqueSources: any[] = [];
    for (const s of ragResult.sources) {
      const key = `${s.sourceType}|${s.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let url: string | undefined;
      if (s.sourceType === 'google_docs' && s.description) {
        url = `https://docs.google.com/document/d/${s.description}/edit`;
      } else if (s.sourceType === 'km_system' && s.path) {
        url = `${config.kmBaseUrl}/${s.path}`;
      } else if (s.sourceType === 'notion' && s.description) {
        url = `https://www.notion.so/${s.description}`;
      }
      uniqueSources.push({
        sourceType: s.sourceType,
        sourceId: s.sourceId,
        title: s.title,
        url,
        description: s.description,
        path: s.path,
      });
    }
    try {
      store.setLastRagContext(userId, userName, {
        question,
        answeredAt: new Date().toISOString(),
        sources: uniqueSources.slice(0, 10),  // 最多記 10 個，防爆增
      });
    } catch (err: any) {
      console.error('[TeamsBot] 儲存 lastRagContext 失敗:', err.message);
    }
  }

  private async replaceCardWithText(
    context: TurnContext,
    text: string,
    color: 'Default' | 'Good' | 'Attention' = 'Default',
  ): Promise<void> {
    const simpleCard = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: [
        {
          type: 'TextBlock',
          text,
          wrap: true,
          color,
        },
      ],
    };

    const activityId = context.activity.replyToId;
    if (activityId) {
      try {
        await context.updateActivity({
          type: 'message',
          id: activityId,
          attachments: [CardFactory.adaptiveCard(simpleCard)],
        });
        return;
      } catch (err: any) {
        console.error('[TeamsBot] updateActivity 失敗，fallback 成 sendActivity:', err.message);
      }
    }
    await context.sendActivity(text);
  }

  /**
   * 把原卡片替換成新的 adaptive card（成功後的結果卡）
   */
  private async replaceCardWithCard(
    context: TurnContext,
    card: object,
  ): Promise<void> {
    const activityId = context.activity.replyToId;
    if (activityId) {
      try {
        await context.updateActivity({
          type: 'message',
          id: activityId,
          attachments: [CardFactory.adaptiveCard(card)],
        });
        return;
      } catch (err: any) {
        console.error('[TeamsBot] updateActivity 失敗，fallback 成 sendActivity:', err.message);
      }
    }
    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
    );
  }

  /**
   * submit_note：存新筆記，把原輸入卡片替換成成功卡片（清掉輸入文字）
   */
  private async handleSubmitNote(
    context: TurnContext,
    userId: string,
    userName: string,
    data: any,
  ): Promise<void> {
    const content = data.inputContent?.trim();
    if (!content) {
      await this.replaceCardWithText(context, '⚠️ 內容為空，沒有記錄任何東西', 'Attention');
      return;
    }
    const note = store.addNote(userId, userName, content);
    await this.replaceCardWithCard(context, createNoteConfirmCard(note));
  }

  /**
   * submit_reminder：存新提醒，把原輸入卡片替換成成功卡片
   */
  private async handleSubmitReminder(
    context: TurnContext,
    userId: string,
    userName: string,
    data: any,
  ): Promise<void> {
    const raw = data.inputContent?.trim();
    if (!raw) {
      await this.replaceCardWithText(context, '⚠️ 內容為空，沒有新增提醒', 'Attention');
      return;
    }
    // 從輸入內容解析日期+時間（例如 "4/20 14:00 開會"、"明天下午兩點 開會"）
    const parsed = extractDate(raw);
    const reminder = store.addReminder(
      userId,
      userName,
      parsed.content,
      parsed.dueDate,
      parsed.dueTime,
    );
    await this.replaceCardWithCard(context, createReminderConfirmCard(reminder));
  }

  // ── 從筆記列表點「發布」：顯示平台選擇卡 ──

  private async handlePublishSelectPlatform(
    context: TurnContext,
    userId: string,
    noteId: number,
  ): Promise<void> {
    const note = store.getNote(userId, noteId);
    if (!note) {
      await context.sendActivity(`找不到筆記 #${noteId}`);
      return;
    }
    const preview = note.content.length > 80 ? note.content.slice(0, 80) + '...' : note.content;
    const card = createPlatformPickerCard(
      note.id,
      `📄 筆記 #${note.id}\n\n${preview}`,
      '📤 請選擇要發布到哪個平台（發布時會由 AI 自動整理標題與排版）',
    );
    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card)),
    );
  }

  // ── 刪除筆記流程 ──

  private async handleDeleteNoteAsk(
    context: TurnContext,
    userId: string,
    noteId: number,
  ): Promise<void> {
    const note = store.getNote(userId, noteId);
    if (!note) {
      await context.sendActivity(`找不到筆記 #${noteId}`);
      return;
    }
    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(createDeleteNoteConfirmCard(note))),
    );
  }

  /**
   * 完成提醒：標記完成、把原列表卡就地更新（扣掉這則）、送小提示
   */
  private async handleCompleteReminder(
    context: TurnContext,
    userId: string,
    reminderId: number,
  ): Promise<void> {
    const completed = store.completeReminder(userId, reminderId);
    if (!completed) {
      await context.sendActivity(`⚠️ 找不到提醒 #${reminderId}`);
      return;
    }
    console.log(`[TeamsBot] 完成提醒: userId=${userId}, reminderId=${reminderId}`);

    // 提醒完成 → 清理附圖 Blob（圖不會再被用到）
    if (completed.images && completed.images.length > 0) {
      blobDeleteImages(completed.images.map((i) => i.blobName))
        .catch((err) => console.error('[TeamsBot] 提醒附圖清理失敗:', err.message));
    }

    // 嘗試就地更新原列表卡（移除已完成的提醒）
    // 注意：proactive 推送的卡片可能沒有有效的 replyToId，updateActivity 可能失敗
    try {
      const remainingReminders = store.listPendingReminders(userId);
      await this.replaceCardWithCard(context, createReminderListCard(remainingReminders));
    } catch (err: any) {
      console.error('[TeamsBot] handleCompleteReminder replaceCard 失敗:', err.message);
      // 卡片更新失敗沒關係，下面的確認訊息才是主要回饋
    }

    // 送一則確認訊息（這個應該一定能成功）
    try {
      await context.sendActivity(`✅ 已完成 #${reminderId} ${completed.content}`);
    } catch (err: any) {
      console.error('[TeamsBot] handleCompleteReminder sendActivity 失敗:', err.message);
    }
  }

  private async handleDeleteNoteConfirm(
    context: TurnContext,
    userId: string,
    noteId: number,
  ): Promise<void> {
    const removed = store.deleteNote(userId, noteId);
    if (!removed) {
      // 原筆記已不存在（可能是舊的列表卡片重複點擊），送一則提示、不動原卡片
      await context.sendActivity(`⚠️ 筆記 #${noteId} 已不存在，可能已被刪除過`);
      return;
    }
    console.log(`[TeamsBot] 刪除筆記: userId=${userId}, noteId=${noteId}`);

    // 刪除筆記 → 清理附圖 Blob
    if (removed.images && removed.images.length > 0) {
      blobDeleteImages(removed.images.map((i) => i.blobName))
        .catch((err) => console.error('[TeamsBot] 筆記附圖清理失敗:', err.message));
    }

    // 把被點擊的原列表卡片就地更新成扣掉這則後的新列表
    const remainingNotes = store.listNotes(userId);
    await this.replaceCardWithCard(context, createNoteListCard(remainingNotes));

    // 附上一則小提示當作刪除確認（原列表更新是主要視覺回饋）
    await context.sendActivity(`🗑 已刪除筆記 #${noteId}`);
  }

  // ── Card Action 統一處理（Action.Submit 走 onMessage）──

  private async handleCardAction(context: TurnContext, data: any): Promise<void> {
    const userId = context.activity.from.id;
    const userName = context.activity.from.name || '';

    switch (data.action) {
      case 'command_menu':
        await this.handleMenuAction(context, userId, userName, data.command);
        break;

      case 'complete_reminder':
        await this.handleCompleteReminder(context, userId, data.reminderId);
        break;

      case 'submit_note':
        await this.handleSubmitNote(context, userId, userName, data);
        break;

      case 'submit_reminder':
        await this.handleSubmitReminder(context, userId, userName, data);
        break;

      case 'cancel_input':
        await this.replaceCardWithText(context, '✖️ 已取消');
        break;

      case 'publish_to':
        await this.handlePublishPlatformSelected(context, userId, data.noteId, data.platform);
        break;

      case 'publish_select_platform':
        await this.handlePublishSelectPlatform(context, userId, data.noteId);
        break;

      case 'publish_confirm':
        await this.handlePublishConfirm(context, userId, userName, data.noteId, data.platform, data.locationId);
        break;

      case 'delete_note_ask':
        await this.handleDeleteNoteAsk(context, userId, data.noteId);
        break;

      case 'delete_note_confirm':
        await this.handleDeleteNoteConfirm(context, userId, data.noteId);
        break;

      case 'edit_document':
        await this.handleEditDocumentDecision(context, userId, userName, data);
        break;

      case 'append_document':
        await this.handleAppendToDocument(context, userId, userName, data);
        break;

      default:
        console.log(`[TeamsBot] 未知的 card action: ${data.action}`);
    }
  }

  // ── 知識庫修改流程 ──

  /**
   * AI 解析自然語言修改指令
   * 支援從上一則 RAG 回答的 lastRagContext resolve「這兩份」「第一份」等代名詞。
   */
  private async handleEditKbNaturalLanguage(
    context: TurnContext,
    userId: string,
    userName: string,
    description: string,
  ): Promise<void> {
    await context.sendActivities([{ type: 'typing' }]);

    // 拿上一則 RAG 回答的來源當上下文
    const lastCtx = store.getLastRagContext(userId);
    const intent = await parseEditIntent(description, lastCtx);

    if (!intent) {
      await context.sendActivity('無法理解修改意圖，請用以下格式：\n• `#修改 把「舊文字」改成「新文字」`\n• `#修改 在XXX文件加上 內容`');
      return;
    }

    if (intent.action === 'replace' && intent.oldText && intent.newText) {
      await this.handleEditKbStart(context, userId, userName, intent.oldText, intent.newText);
      return;
    }

    if (intent.action === 'append' && intent.appendContent) {
      // 優先用 targetSourceIds（從對話上下文 resolve 的）
      let candidates: EditCandidate[] = [];
      if (intent.targetSourceIds && intent.targetSourceIds.length > 0) {
        candidates = getCandidatesBySourceIds(intent.targetSourceIds);
        console.log(`[TeamsBot] 從 lastRagContext resolve 到 ${candidates.length} 份候選（targetSourceIds=${intent.targetSourceIds.join(',')}）`);
      }

      // 沒 resolve 到 → 用 targetDocument keyword 搜尋（舊行為）
      if (candidates.length === 0 && intent.targetDocument) {
        candidates = searchDocumentsByTitle(intent.targetDocument);
      }

      await this.handleAppendStart(
        context,
        userId,
        userName,
        intent.targetDocument || '',
        intent.appendContent,
        candidates,
      );
      return;
    }

    await context.sendActivity('無法理解修改意圖，請再描述清楚一點。');
  }

  /**
   * 啟動附加流程：顯示候選文件選擇卡片。
   * candidates 可以是從 targetSourceIds resolve 來的，也可以是從 keyword 搜尋來的。
   */
  private async handleAppendStart(
    context: TurnContext,
    userId: string,
    userName: string,
    targetDocKeyword: string,
    appendContent: string,
    preResolvedCandidates?: EditCandidate[],
  ): Promise<void> {
    // 優先用已經 resolve 好的候選清單
    const candidates = preResolvedCandidates && preResolvedCandidates.length > 0
      ? preResolvedCandidates
      : (targetDocKeyword ? searchDocumentsByTitle(targetDocKeyword) : []);

    if (candidates.length === 0) {
      await context.sendActivity(
        targetDocKeyword
          ? `找不到標題包含「${targetDocKeyword}」的文件。請確認文件名稱。`
          : '找不到符合的文件。請指定文件名稱（例：「在工程新進人員文件加上 ...」）、或先問一個問題讓我知道你要修改哪份。',
      );
      return;
    }

    // 建立 session
    cleanExpiredSessions();
    const sessionId = `append_${Date.now()}_${userId.slice(-6)}`;
    editSessions.set(sessionId, {
      oldText: '',
      newText: appendContent,
      candidates,
      decisions: new Map(),
      userId,
      userName,
      createdAt: Date.now(),
    });

    // 顯示選擇卡片
    await context.sendActivity(
      MessageFactory.attachment(
        CardFactory.adaptiveCard(createAppendPreviewCard(appendContent, candidates, sessionId)),
      ),
    );
  }

  /**
   * 處理附加內容：用戶選擇了目標文件
   */
  private async handleAppendToDocument(
    context: TurnContext,
    userId: string,
    userName: string,
    data: any,
  ): Promise<void> {
    const { editSessionId, sourceId } = data;
    const session = editSessions.get(editSessionId);

    if (!session) {
      await context.sendActivity('操作已過期，請重新輸入 #修改 指令。');
      return;
    }

    const candidate = session.candidates.find((c) => c.sourceId === sourceId);
    if (!candidate) {
      await context.sendActivity('找不到對應的文件。');
      return;
    }

    await context.sendActivities([{ type: 'typing' }]);

    // 取得 Teams 用戶 email 作為作者 / Google Docs DWD impersonation
    const userEmail = await this.getUserEmail(context);

    // 依 sourceType dispatch
    let result: { success: boolean; error?: string };
    if (candidate.sourceType === 'google_docs') {
      result = await appendToGoogleDoc(candidate.description, session.newText, userEmail);
    } else if (candidate.sourceType === 'km_system') {
      result = await appendToKmPage(candidate.sourceId, session.newText, userEmail);
    } else if (candidate.sourceType === 'notion') {
      result = await appendToNotionPage(candidate.description, session.newText, userName);
    } else {
      result = { success: false, error: `未知的文件來源：${candidate.sourceType}` };
    }

    // 背景重新同步向量庫（不阻塞）
    if (result.success) {
      resyncEditedDocument(candidate.sourceId, candidate.sourceType, candidate.description)
        .catch((err) => console.error(`[TeamsBot] append 背景 resync 失敗:`, err.message));
    }

    // 儲存紀錄
    addEditLog(session.userId, session.userName, '(附加內容)', session.newText, [{
      sourceId: candidate.sourceId,
      sourceType: candidate.sourceType,
      title: candidate.title,
      action: 'approved',
      editResult: result,
    }]);

    // 產生文件連結
    let docUrl = '';
    if (candidate.sourceType === 'google_docs') {
      docUrl = `https://docs.google.com/document/d/${candidate.description}/edit`;
    } else if (candidate.sourceType === 'km_system') {
      docUrl = `${config.kmBaseUrl}/${candidate.path}`;
    } else if (candidate.sourceType === 'notion' && candidate.description) {
      docUrl = `https://www.notion.so/${candidate.description}`;
    }

    // 回覆結果
    if (result.success) {
      await context.sendActivity(
        MessageFactory.attachment(
          CardFactory.adaptiveCard(createAppendSuccessCard(candidate.title, candidate.sourceType, docUrl)),
        ),
      );
    } else {
      await context.sendActivity(`❌ 附加失敗：${result.error}`);
    }

    editSessions.delete(editSessionId);
  }

  /**
   * 啟動修改流程：搜尋受影響文件，顯示預覽卡片
   */
  private async handleEditKbStart(
    context: TurnContext,
    userId: string,
    userName: string,
    oldText: string,
    newText: string,
  ): Promise<void> {
    await context.sendActivities([{ type: 'typing' }]);

    // 搜尋包含舊文字的文件
    const candidates = searchDocumentsContaining(oldText);

    if (candidates.length === 0) {
      await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(createEditNoMatchCard(oldText))),
      );
      return;
    }

    // 建立 session
    cleanExpiredSessions();
    const sessionId = `edit_${Date.now()}_${userId.slice(-6)}`;
    editSessions.set(sessionId, {
      oldText,
      newText,
      candidates,
      decisions: new Map(),
      userId,
      userName,
      createdAt: Date.now(),
    });

    console.log(`[TeamsBot] 修改流程啟動: "${oldText}" → "${newText}", ${candidates.length} 份文件, session=${sessionId}`);

    // 顯示預覽卡片
    await context.sendActivity(
      MessageFactory.attachment(
        CardFactory.adaptiveCard(createEditPreviewCard(oldText, newText, candidates, sessionId)),
      ),
    );
  }

  /**
   * 處理修改流程中的單一文件確認/跳過
   */
  private async handleEditDocumentDecision(
    context: TurnContext,
    userId: string,
    userName: string,
    data: any,
  ): Promise<void> {
    const { editSessionId, sourceId, decision } = data;
    const session = editSessions.get(editSessionId);

    if (!session) {
      await context.sendActivity('修改流程已過期，請重新輸入 #修改 指令。');
      return;
    }

    const candidate = session.candidates.find((c) => c.sourceId === sourceId);
    if (!candidate) {
      await context.sendActivity('找不到對應的文件。');
      return;
    }

    // 已經處理過
    if (session.decisions.has(sourceId)) {
      await context.sendActivity(`文件「${candidate.title}」已經處理過了。`);
      return;
    }

    if (decision === 'skip') {
      session.decisions.set(sourceId, {
        sourceId,
        sourceType: candidate.sourceType,
        title: candidate.title,
        action: 'skipped',
      });
      editSessions.set(editSessionId, session); // 持久化 decisions 變更
      await context.sendActivity(`⏭ 已跳過「${candidate.title}」`);
    } else if (decision === 'approve') {
      await context.sendActivities([{ type: 'typing' }]);

      // 取得 Teams 用戶 email 作為作者
      const userEmail = await this.getUserEmail(context);

      // 執行修改
      let editResult: { success: boolean; error?: string };
      if (candidate.sourceType === 'google_docs') {
        editResult = await editGoogleDoc(candidate.description, session.oldText, session.newText, userEmail);
      } else if (candidate.sourceType === 'km_system') {
        editResult = await editKmPage(candidate.sourceId, session.oldText, session.newText, userEmail);
      } else if (candidate.sourceType === 'notion') {
        editResult = await editNotionPage(candidate.description, session.oldText, session.newText, session.userName);
      } else {
        editResult = { success: false, error: `未知的文件來源：${candidate.sourceType}` };
      }

      // 修改成功則背景重新同步向量庫（不阻塞）
      if (editResult.success) {
        resyncEditedDocument(candidate.sourceId, candidate.sourceType, candidate.description)
          .catch((err) => console.error(`[TeamsBot] 背景 resync 失敗:`, err.message));
      }

      session.decisions.set(sourceId, {
        sourceId,
        sourceType: candidate.sourceType,
        title: candidate.title,
        action: 'approved',
        editResult,
      });
      editSessions.set(editSessionId, session); // 持久化 decisions 變更

      const icon = candidate.sourceType === 'google_docs' ? '📝'
        : candidate.sourceType === 'notion' ? '📓'
        : '📄';
      if (editResult.success) {
        await context.sendActivity(`✅ ${icon} 「${candidate.title}」修改成功`);
      } else {
        await context.sendActivity(`❌ ${icon} 「${candidate.title}」修改失敗：${editResult.error}`);
      }
    }

    // 檢查是否全部處理完
    if (session.decisions.size === session.candidates.length) {
      // 儲存修改紀錄
      const allResults = Array.from(session.decisions.values());
      addEditLog(session.userId, session.userName, session.oldText, session.newText, allResults);

      // 顯示結果卡片
      await context.sendActivity(
        MessageFactory.attachment(
          CardFactory.adaptiveCard(createEditResultCard(session.oldText, session.newText, allResults)),
        ),
      );

      // 清理 session
      editSessions.delete(editSessionId);
    }
  }

  /**
   * 取得 Teams 用戶的 email（用於對應 Wiki.js 使用者）
   */
  private async getUserEmail(context: TurnContext): Promise<string> {
    try {
      const member = await TeamsInfo.getMember(context, context.activity.from.id);
      return (member as any).email || member.userPrincipalName || context.activity.from.name || '';
    } catch (err: any) {
      console.error('[TeamsBot] 取得用戶 email 失敗:', err.message);
      return context.activity.from.name || '';
    }
  }

  // ── 工具方法 ──

  private isBotMentioned(context: TurnContext): boolean {
    if (!context.activity.entities) return false;
    return context.activity.entities.some(
      (e) => e.type === 'mention' && e.mentioned?.id === context.activity.recipient.id,
    );
  }

  private removeMentionText(context: TurnContext): string {
    let text = context.activity.text || '';

    if (context.activity.entities) {
      for (const entity of context.activity.entities) {
        if (entity.type === 'mention' && entity.mentioned?.id === context.activity.recipient.id) {
          const mentionText = entity.text || '';
          text = text.replace(mentionText, '');
        }
      }
    }

    // Teams 有時會把訊息 textFormat='xml' 包成 HTML（例如 <p>內容</p>、<at>...</at>）
    // 剝 HTML tag、將 &nbsp; / &amp; / &lt; / &gt; / &quot; / &#39; 解碼
    text = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ');

    return text.trim();
  }
}
