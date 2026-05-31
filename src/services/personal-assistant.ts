import { AzureOpenAI } from 'openai';
import { config } from '../config';
import * as store from './personal-store';
import {
  createCommandMenuCard,
  createInputPromptCard,
  createNoteConfirmCard,
  createReminderConfirmCard,
  createReminderListCard,
  createNoteListCard,
  createSearchResultCard,
  createReminderCompletedCard,
  createPublishSuggestionCard,
  createHelpCard,
} from '../bot/personal-cards';

const client = new AzureOpenAI({
  endpoint: config.azureOpenai.endpoint,
  apiKey: config.azureOpenai.apiKey,
  apiVersion: config.azureOpenai.apiVersion,
});

// ── 意圖分類 ──

export type Intent =
  | { type: 'save_note'; content: string }
  | { type: 'add_reminder'; content: string; dueDate: string | null; dueTime?: string }
  | { type: 'query_reminders' }
  | { type: 'complete_reminder'; reminderId: number }
  | { type: 'list_notes' }
  | { type: 'search_personal'; keyword: string }
  | { type: 'publish'; noteId: number; platform?: string }
  | { type: 'edit_kb'; oldText?: string; newText?: string; description?: string }
  | { type: 'help' }
  | { type: 'greeting' }
  | { type: 'knowledge_query' };

/**
 * 用 GPT 判斷用戶意圖（1:1 私訊中不帶 # 的訊息）
 */
export async function classifyIntent(message: string, userId: string): Promise<Intent> {
  // 取得用戶的待辦摘要，幫助 GPT 判斷「完成」類意圖
  const pendingReminders = store.listPendingReminders(userId);
  const reminderContext = pendingReminders.length > 0
    ? `\n用戶目前的待辦：\n${pendingReminders.map((r) => `#${r.id} ${r.content}${r.dueDate ? ` (${r.dueDate})` : ''}`).join('\n')}`
    : '\n用戶目前沒有待辦。';

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;

  const systemPrompt = `你是個人助理的意圖分類器。根據用戶訊息，判斷屬於以下哪種意圖，回傳 JSON。

今天日期：${todayStr}

意圖類型：
- add_reminder：要新增一則提醒/待辦。如「明天下午兩點開會」「提醒我 4/20 交月報」「幫我記著下週一要打電話給客戶」
- save_note：要記錄一則筆記（不是提醒、沒時間性）。如「記一下折扣碼設定需要注意 XX」「記事：新進員工 slack 帳號..」
- query_reminders：詢問自己的待辦、提醒、要做什麼事。如「我今天要做什麼」「看一下我的待辦」
- list_notes：想看自己記過的全部筆記列表（沒有特定關鍵字）。如「筆記」「筆記列表」「我的筆記」「看我記過的」「最近記了什麼」
- search_personal：搜尋自己過去記錄的筆記或提醒（**有明確關鍵字**）。如「我之前記的客戶 A 那個」「找我寫過關於運費的筆記」「搜尋訂單 R08」
- complete_reminder：表示某件事做完了。如「4/20 開會那個搞定了」
- edit_kb：想要修改/修正/更新知識庫中的錯誤內容（KM / Google Docs / Notion）。如「把 X 改成 Y」「幫我在工程新進人員文件加上 xxx」
- knowledge_query：詢問公司系統、流程、業務規則等知識性問題。如「運費怎麼算」「R08 是什麼」
- greeting：純問候、閒聊、打招呼。如「你好」「嗨」「hello」「謝謝」
- help：詢問 bot 怎麼用、有什麼功能

判斷規則：
- 明確的時間關鍵字（明天、後天、下午X點、HH:MM、M/D 日期）+「提醒/記得/要...」→ **add_reminder**
- 用戶說「記一下」「記事」「備忘」「幫我記」但沒時間性 → **save_note**
- 問自己要做什麼、查待辦 → query_reminders
- 只說「筆記」「筆記列表」「看我的筆記」「我記過什麼」這種**沒有具體關鍵字**的要求 → list_notes
- 有明確搜尋關鍵字（「找 XX」「我之前記的 XX」）→ search_personal
- 說「做完了」「完成了」→ complete_reminder，從上面待辦列表找匹配的 reminderId
- 說「改成」「修正」「修改」「知識庫」「KM」「在 XX 文件加上」→ edit_kb（把整個描述放進 description 欄位，讓後面的系統用 AI 解析）
- 問通用公司知識 → knowledge_query
- 純 hi/hello/謝謝等 → greeting

${reminderContext}

回傳格式（只回傳 JSON，不要其他文字）：
{"type": "add_reminder", "content": "提醒內容（去掉日期時間關鍵字）", "dueDate": "YYYY-MM-DD 或 null", "dueTime": "HH:MM 或省略"}
{"type": "save_note", "content": "要記錄的內容（去掉『記一下』之類前綴）"}
{"type": "query_reminders"}
{"type": "list_notes"}
{"type": "search_personal", "keyword": "搜尋關鍵字"}
{"type": "complete_reminder", "reminderId": 數字}
{"type": "edit_kb", "description": "整段原始修改描述"}
{"type": "knowledge_query"}
{"type": "greeting"}
{"type": "help"}`;

  try {
    const response = await client.chat.completions.create({
      model: config.chatModel,
      max_tokens: 200,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
    });

    const raw = response.choices[0]?.message?.content || '';
    // 嘗試從回覆中提取 JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as Intent;
    }
  } catch (error: any) {
    console.error('[PersonalAssistant] 意圖分類失敗:', error.message);
  }

  // 預設走知識庫
  return { type: 'knowledge_query' };
}

// ── # 指令解析 ──

export interface ParsedCommand {
  type:
    | 'menu'
    | 'note'
    | 'note_prompt'       // 裸 #記事 → 跳輸入卡片
    | 'reminder'
    | 'reminder_prompt'   // 裸 #提醒 → 跳輸入卡片
    | 'todo'
    | 'complete'
    | 'notes'
    | 'search'
    | 'publish'
    | 'publish_direct'
    | 'edit_kb'
    | 'help';
  content?: string;
  dueDate?: string | null;
  dueTime?: string;
  id?: number;
  platform?: string;
  oldText?: string;
  newText?: string;
}

/**
 * 解析指令（支援 # 和 / 前綴）
 * Teams 指令選單會送出 "/記事 xxx" 格式，手動輸入用 "#記 xxx"
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();

  // 單獨一個 # → 顯示選單
  if (trimmed === '#') {
    return { type: 'menu' };
  }

  // 統一處理：移除 # 或 / 前綴，統一格式
  // 支援：#記 xxx, /記事 xxx, /記 xxx
  const normalized = trimmed
    .replace(/^[#\/]\s*/, '');  // 移除 # 或 / 和後面的空格

  // 記事 / 記（有內容）
  const noteMatch = normalized.match(/^記[事]?\s+(.+)/s);
  if (noteMatch) {
    return { type: 'note', content: noteMatch[1].trim() };
  }
  // 裸 #記事 / #記 → 跳輸入卡片（Teams commandList 建議欄位會送出這種）
  if (/^記[事]?$/.test(normalized)) {
    return { type: 'note_prompt' };
  }

  // 提醒（有內容）
  const reminderMatch = normalized.match(/^提醒\s+(.+)/s);
  if (reminderMatch) {
    const rest = reminderMatch[1].trim();
    const dateResult = extractDate(rest);
    return {
      type: 'reminder',
      content: dateResult.content,
      dueDate: dateResult.dueDate,
      ...(dateResult.dueTime ? { dueTime: dateResult.dueTime } : {}),
    };
  }
  // 裸 #提醒 → 跳輸入卡片
  if (/^提醒$/.test(normalized)) {
    return { type: 'reminder_prompt' };
  }

  // 待辦
  if (/^待辦$/.test(normalized)) {
    return { type: 'todo' };
  }

  // 完成 <id>
  const completeMatch = normalized.match(/^完成\s+(\d+)/);
  if (completeMatch) {
    return { type: 'complete', id: parseInt(completeMatch[1], 10) };
  }
  // 裸 #完成 → 列出未完成的待辦，讓用戶點按鈕完成（等同於 #待辦）
  if (/^完成$/.test(normalized)) {
    return { type: 'todo' };
  }

  // 筆記
  if (/^筆記$/.test(normalized)) {
    return { type: 'notes' };
  }

  // 查
  const searchMatch = normalized.match(/^查\s+(.+)/);
  if (searchMatch) {
    return { type: 'search', content: searchMatch[1].trim() };
  }

  // 發布（兩種模式）
  // 模式 1：#發布 <編號> [平台] → 發布已存在的筆記
  // 平台限定 km / gdocs（Notion 不支援從個人筆記新建頁面，只能修改既有頁面）
  const publishByIdMatch = normalized.match(/^發布\s+(\d+)(?:\s+(km|gdocs))?$/);
  if (publishByIdMatch) {
    return {
      type: 'publish',
      id: parseInt(publishByIdMatch[1], 10),
      platform: publishByIdMatch[2] || undefined,
    };
  }

  // 模式 2：#發布 <內容> → 直接發布內容（自動存為筆記再發布）
  const publishDirectMatch = normalized.match(/^發布\s+(.+)/s);
  if (publishDirectMatch) {
    return {
      type: 'publish_direct',
      content: publishDirectMatch[1].trim(),
    };
  }

  // 裸 #發布 → 列出最近筆記，用戶點某則的「📤 發布」按鈕（等同於 #筆記）
  if (/^發布$/.test(normalized)) {
    return { type: 'notes' };
  }

  // 修改知識庫：#修改 + 任意描述（AI 判斷操作類型）
  // 快速匹配格式：#修改 把「舊」改成「新」
  const editQuickMatch = normalized.match(/^修改\s+把[「「](.+?)[」」]改成[「「](.+?)[」」]/);
  if (editQuickMatch) {
    return { type: 'edit_kb', oldText: editQuickMatch[1], newText: editQuickMatch[2] };
  }
  // 通用格式：#修改 + 自然語言描述（由 AI 解析）
  const editMatch = normalized.match(/^修改\s+(.+)/s);
  if (editMatch) {
    return { type: 'edit_kb', content: editMatch[1].trim() };
  }

  // 說明 / help
  if (/^(說明|help)$/i.test(normalized)) {
    return { type: 'help' };
  }

  return null;
}

// ── 指令執行 ──

export interface CommandResult {
  text?: string;
  card?: object;
}

/**
 * 執行 # 指令
 */
export async function handleCommand(
  userId: string,
  userName: string,
  command: ParsedCommand,
): Promise<CommandResult> {
  switch (command.type) {
    case 'menu':
      return { card: createCommandMenuCard() };

    case 'note': {
      const note = store.addNote(userId, userName, command.content!);
      return { card: createNoteConfirmCard(note) };
    }

    case 'note_prompt':
      return { card: createInputPromptCard('note') };

    case 'reminder': {
      const reminder = store.addReminder(
        userId,
        userName,
        command.content!,
        command.dueDate || null,
        command.dueTime,
      );
      return { card: createReminderConfirmCard(reminder) };
    }

    case 'reminder_prompt':
      return { card: createInputPromptCard('reminder') };

    case 'todo': {
      const reminders = store.listPendingReminders(userId);
      return { card: createReminderListCard(reminders) };
    }

    case 'complete': {
      const completed = store.completeReminder(userId, command.id!);
      if (!completed) {
        return { text: `找不到編號 #${command.id} 的提醒` };
      }
      return { card: createReminderCompletedCard(completed) };
    }

    case 'notes': {
      const notes = store.listNotes(userId);
      return { card: createNoteListCard(notes) };
    }

    case 'search': {
      const results = store.searchAll(userId, command.content!);
      return { card: createSearchResultCard(command.content!, results) };
    }

    case 'publish': {
      const note = store.getNote(userId, command.id!);
      if (!note) {
        return { text: `找不到編號 #${command.id} 的筆記` };
      }
      if (command.platform) {
        return {
          text: `準備發布筆記 #${command.id} 到 ${command.platform}，請稍候...`,
        };
      }
      const suggestion = await suggestPublishTarget(note.content);
      const preview = note.content.length > 50 ? note.content.slice(0, 50) + '...' : note.content;
      return { card: createPublishSuggestionCard(note.id, preview, suggestion) };
    }

    case 'publish_direct': {
      // 直接發布內容：先自動存為筆記，再進入發布流程
      const newNote = store.addNote(userId, userName, command.content!);
      const suggestion = await suggestPublishTarget(newNote.content);
      const preview = newNote.content.length > 50 ? newNote.content.slice(0, 50) + '...' : newNote.content;
      return { card: createPublishSuggestionCard(newNote.id, preview, suggestion) };
    }

    case 'help':
      return { card: createHelpCard() };

    default:
      return { text: '無法辨識的指令，輸入 # 查看可用指令。' };
  }
}

/**
 * 處理 AI 意圖（非 # 指令的自然語言）
 */
export async function handleIntent(
  userId: string,
  userName: string,
  intent: Intent,
): Promise<CommandResult> {
  switch (intent.type) {
    case 'add_reminder': {
      const reminder = store.addReminder(
        userId,
        userName,
        intent.content,
        intent.dueDate,
        intent.dueTime,
      );
      return { card: createReminderConfirmCard(reminder) };
    }

    case 'save_note': {
      const note = store.addNote(userId, userName, intent.content);
      return { card: createNoteConfirmCard(note) };
    }

    case 'query_reminders': {
      const reminders = store.listPendingReminders(userId);
      return { card: createReminderListCard(reminders) };
    }

    case 'list_notes': {
      const notes = store.listNotes(userId);
      return { card: createNoteListCard(notes) };
    }

    case 'search_personal': {
      const results = store.searchAll(userId, intent.keyword);
      return { card: createSearchResultCard(intent.keyword, results) };
    }

    case 'complete_reminder': {
      const completed = store.completeReminder(userId, intent.reminderId);
      if (!completed) {
        return { text: `找不到編號 #${intent.reminderId} 的提醒` };
      }
      return { card: createReminderCompletedCard(completed) };
    }

    case 'help':
      return { card: createHelpCard() };

    case 'greeting':
      return {
        text: '你好！我是**後勤知識助手**🤖\n\n' +
              '你可以：\n' +
              '- **問知識**：直接問公司系統、流程、業務規則（例如：運費怎麼算？）\n' +
              '- **記事/提醒**：用自然語言，例如「明天下午兩點提醒我開會」\n' +
              '- **查待辦**：「我今天要做什麼」\n' +
              '- **看指令選單**：輸入 `#`',
      };

    default:
      // knowledge_query + edit_kb 由 teams-bot.ts 處理（需要更多上下文或走專屬流程）
      return {};
  }
}

// ── AI 發布建議 ──

/**
 * 呼叫 GPT 分析筆記內容，建議最適合的發布平台
 */
export async function suggestPublishTarget(
  noteContent: string,
): Promise<{ target: string; reason: string }> {
  const systemPrompt = `你是發布助手。根據以下筆記內容，建議最適合的發布平台。

平台說明：
- km：SOP、流程說明、系統操作指南、Bug 記錄、教學文件、正式的公司知識
- gdocs：會議紀錄、工作日誌、草稿、個人整理的資料

只回傳 JSON，不要其他文字：
{"target": "km 或 gdocs", "reason": "一句話說明理由"}`;

  try {
    const response = await client.chat.completions.create({
      model: config.chatModel,
      max_tokens: 200,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: noteContent },
      ],
    });

    const raw = response.choices[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error: any) {
    console.error('[PersonalAssistant] 發布建議失敗:', error.message);
  }

  return { target: 'km', reason: '預設建議發布到 KM 系統' };
}

/**
 * 呼叫 GPT 建議發布位置
 */
export async function suggestPublishLocation(
  noteContent: string,
  platform: string,
  locations: Array<{ id: string; name: string }>,
): Promise<{ locationId: string; reason: string }> {
  const locationList = locations.map((l) => `- id: "${l.id}", name: "${l.name}"`).join('\n');

  const systemPrompt = `你是發布助手。根據筆記內容，從以下 ${platform} 的位置中選擇最適合的。

可用位置：
${locationList}

只回傳 JSON：
{"locationId": "選擇的 id", "reason": "一句話說明理由"}`;

  try {
    const response = await client.chat.completions.create({
      model: config.chatModel,
      max_tokens: 200,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: noteContent },
      ],
    });

    const raw = response.choices[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error: any) {
    console.error('[PersonalAssistant] 位置建議失敗:', error.message);
  }

  // 預設選第一個
  return {
    locationId: locations[0]?.id || '',
    reason: '預設選擇第一個位置',
  };
}

// ── 發布前 AI 自動整理標題與內文 ──

export interface StructuredPublishContent {
  title: string;
  content: string;
}

/**
 * 把用戶的粗略筆記整理成可發布的標題 + 結構化 markdown 內文
 * - 標題單獨存（≤ 60 字），不在內文再放 H1
 * - 內文用 H2/H3 小標、條列、code fence
 * - 失敗時 fallback 為截斷標題 + 原文（絕不拋例外，發布流程不能中斷）
 */
export async function structureNoteForPublish(
  rawContent: string,
): Promise<StructuredPublishContent> {
  const fallback = (): StructuredPublishContent => ({
    title: rawContent.length > 30 ? rawContent.slice(0, 30) + '...' : rawContent,
    content: rawContent,
  });

  // 過長的內容跳過 AI（避免 token 超量 / timeout）
  if (rawContent.length > 8000) {
    console.log(`[PersonalAssistant] structureNoteForPublish 跳過 AI (${rawContent.length} 字 > 8000)`);
    return fallback();
  }
  // 過短的內容也跳過 AI，避免 AI 把帳密 / token / 短字串誤包成 code block（視覺上跟標籤脫節）
  if (rawContent.length < 300) {
    console.log(`[PersonalAssistant] structureNoteForPublish 跳過 AI (${rawContent.length} 字 < 300，保留原文)`);
    // 短筆記用第一行當標題、其餘當內文；若沒有換行就用前 30 字做標題
    const firstLineBreak = rawContent.indexOf('\n');
    if (firstLineBreak > 0 && firstLineBreak <= 40) {
      return {
        title: rawContent.slice(0, firstLineBreak).trim() || rawContent.slice(0, 30),
        content: rawContent.slice(firstLineBreak + 1).trim() || rawContent,
      };
    }
    return fallback();
  }

  const systemPrompt = `你是一位文件編輯助手。用戶寫了一則粗略的筆記，想要發布到公司的知識庫。
請把它整理成：
1. 一個精簡的標題（≤30 個中文字或 ≤50 個英文字），不加標點符號結尾，不加引號
2. 一份結構化的 markdown 內文，使用 H2/H3 標題、條列、程式碼 block

規則：
- 內文絕對不要放最上層的 "# " H1 標題（title 欄位會由系統單獨使用）
- 小標最多從 "## " 開始
- 完整保留原文的所有事實資訊，不要捏造、省略、或過度摘要
- 只做排版調整：加小標、分組條列、多行程式碼用 fenced code block
- **不要**把單一 token / 密碼 / 短字串 / 標籤後的值（例如「密碼：xxx」「帳號：xxx」）包成 fenced code block，這樣會跟標籤脫節。若要強調可用行內 \`backtick\` 或直接留原樣
- 保持原文的語言（中/英/混合）

只回傳 JSON，格式如下（content 內的換行用 \\n）：
{"title": "...", "content": "..."}`;

  try {
    const response = await client.chat.completions.create({
      model: config.chatModel,
      max_tokens: 4000,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawContent },
      ],
    });

    const raw = response.choices[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[PersonalAssistant] structureNoteForPublish 回傳不是 JSON，使用 fallback');
      return fallback();
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<StructuredPublishContent>;
    let title = (parsed.title || '').trim();
    let content = (parsed.content || '').trim();

    if (!title) title = fallback().title;
    if (!content) content = rawContent;
    if (title.length > 60) title = title.slice(0, 60);

    console.log(`[PersonalAssistant] structureNoteForPublish 成功: "${title}" (${content.length} 字)`);
    return { title, content };
  } catch (error: any) {
    console.error('[PersonalAssistant] structureNoteForPublish 失敗:', error.message);
    return fallback();
  }
}

// ── AI 修改意圖解析 ──

export interface EditIntent {
  action: 'replace' | 'append';
  targetDocument?: string;      // 明確文件名關鍵字
  targetSourceIds?: string[];   // 從對話上下文 resolve 的 sourceId 列表
  oldText?: string;             // replace 時的舊文字
  newText?: string;             // replace 時的新文字
  appendContent?: string;       // append 時要附加的內容
}

/**
 * 用 GPT 解析修改指令的自然語言描述。
 * 可選 lastRagContext：讓 AI 把「這兩份」「第一個」等代名詞 resolve 成 targetSourceIds。
 */
export async function parseEditIntent(
  description: string,
  lastRagContext?: {
    question: string;
    answeredAt: string;
    sources: Array<{ sourceType: string; sourceId: string; title: string }>;
  },
): Promise<EditIntent | null> {
  // 組上下文區塊給 GPT
  let contextBlock = '';
  if (lastRagContext && lastRagContext.sources.length > 0) {
    const sourcesDesc = lastRagContext.sources
      .map((s, i) => `  [${i + 1}] sourceType=${s.sourceType}, sourceId="${s.sourceId}", title="${s.title}"`)
      .join('\n');
    contextBlock = `\n\n上一則 RAG 回答的來源（用戶若用代名詞「這份/那兩份/第一個/兩份都/所有」等，從這裡 resolve 出 sourceId）：\n${sourcesDesc}\n用戶上次問的問題：「${lastRagContext.question}」`;
  }

  const systemPrompt = `你是知識庫修改助手。用戶要修改公司知識庫的文件，請解析他的意圖。

支援兩種操作：
1. replace（替換）：把文件中的某段文字改成另一段
2. append（附加）：在指定文件中新增內容

回傳 JSON（只回傳 JSON，不要其他文字）：

範例 A — 明確指定文件名：
用戶：在工程新進人員文件加上 Nas帳號 登入連結：https://xxx
回傳：{"action":"append","targetDocument":"工程新進人員文件","appendContent":"Nas帳號\\n登入連結：https://xxx"}

範例 B — 替換文字：
用戶：把「自2024/1/4起」改成「自2024/1/1起」
回傳：{"action":"replace","oldText":"自2024/1/4起","newText":"自2024/1/1起"}

範例 C — 用代名詞指上次 RAG 的來源：
（假設上次 RAG 回答有：[1] sourceId="8100001" title="運費計算後折"、[2] sourceId="8100002" title="運費後折說明"）
用戶：兩份文件都增加附註，當日配已於2025年10月取消
回傳：{"action":"append","targetSourceIds":["8100001","8100002"],"appendContent":"當日配已於2025年10月取消"}

範例 D — 代名詞指單份：
用戶：第一份加上補充說明：XXX
回傳：{"action":"append","targetSourceIds":["8100001"],"appendContent":"補充說明：XXX"}

注意：
- appendContent 中的換行用 \\n 表示
- 若用戶用代名詞（「這份」「那兩份」「第一/第二個」「兩份都」「所有」），**優先 resolve 成 targetSourceIds**
- 若用戶明確講文件名，用 targetDocument
- 「把 X 改成 Y」→ replace
- 「加上」「新增」「補充」「附註」→ append${contextBlock}`;

  try {
    const response = await client.chat.completions.create({
      model: config.chatModel,
      max_tokens: 600,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: description },
      ],
    });

    const raw = response.choices[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as EditIntent;
    }
  } catch (error: any) {
    console.error('[PersonalAssistant] 修改意圖解析失敗:', error.message);
  }

  return null;
}

// ── 日期提取工具 ──

/**
 * 從使用者輸入擷取日期 + 時間，剩下的是提醒內容。
 * 支援格式（範例）：
 *   - "4/20 檢查出貨"              → dueDate=YYYY-04-20, dueTime=undefined
 *   - "4/20 14:00 開會"            → dueDate, dueTime=14:00
 *   - "4/20 下午兩點 開會"         → dueDate, dueTime=14:00
 *   - "4/20 下午兩點半 開會"       → dueDate, dueTime=14:30
 *   - "明天 14:30 開會"             → dueDate=明天, dueTime=14:30
 *   - "明天 下午 2 點 開會"         → dueDate=明天, dueTime=14:00
 *   - "明天 2pm 開會"              → dueDate=明天, dueTime=14:00
 *   - "後天 9:30 開會"             → dueDate=後天, dueTime=09:30
 *   - "下週一 14:00 開會"          → dueDate=下週一, dueTime=14:00
 */
export function extractDate(
  text: string,
): { content: string; dueDate: string | null; dueTime?: string } {
  const now = new Date();
  const year = now.getFullYear();

  // Step 1：先分離出日期，拿到剩下的字串 rest + dueDate
  let rest = text;
  let dueDate: string | null = null;

  // M/D 格式（後面內容可有可無）
  const dateMatch = rest.match(/^(\d{1,2})\/(\d{1,2})(?:\s+(.*))?$/s);
  if (dateMatch) {
    const month = parseInt(dateMatch[1], 10);
    const day = parseInt(dateMatch[2], 10);
    dueDate = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    rest = dateMatch[3] || '';
  } else {
    const isoMatch = rest.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/s);
    if (isoMatch) {
      dueDate = isoMatch[1];
      rest = isoMatch[2] || '';
    } else if (rest.startsWith('明天')) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      dueDate = toLocalISODate(tomorrow);
      rest = rest.replace(/^明天\s*/, '');
    } else if (rest.startsWith('後天')) {
      const dayAfter = new Date(now);
      dayAfter.setDate(dayAfter.getDate() + 2);
      dueDate = toLocalISODate(dayAfter);
      rest = rest.replace(/^後天\s*/, '');
    } else if (rest.startsWith('今天')) {
      dueDate = toLocalISODate(now);
      rest = rest.replace(/^今天\s*/, '');
    } else {
      const weekdayMatch = rest.match(/^下週([一二三四五六日])\s*(.*)/s);
      if (weekdayMatch) {
        const weekdayMap: Record<string, number> = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
        const targetDay = weekdayMap[weekdayMatch[1]];
        if (targetDay !== undefined) {
          const current = now.getDay();
          const daysUntil = ((targetDay - current + 7) % 7) + 7; // 下週
          const target = new Date(now);
          target.setDate(target.getDate() + daysUntil);
          dueDate = toLocalISODate(target);
          rest = weekdayMatch[2];
        }
      }
    }
  }

  // Step 2：從 rest 前端再擷取時間，拿到 dueTime 和去掉時間後的 content
  const timeResult = extractTime(rest);

  // dueTime 必須搭配 dueDate 才有意義（沒日期就丟掉時間）
  const dueTime = dueDate ? timeResult.dueTime : undefined;

  return {
    content: (timeResult.rest || text).trim(),
    dueDate,
    ...(dueTime ? { dueTime } : {}),
  };
}

/**
 * 把 Date 轉成本地時區的 YYYY-MM-DD（不要用 toISOString，那是 UTC 可能差一天）
 */
function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 從字串前端擷取時間關鍵字，回傳 { dueTime: "HH:MM", rest: 去掉時間後剩下的 }
 * 不命中則 dueTime=undefined, rest=原字串
 */
function extractTime(
  text: string,
): { dueTime?: string; rest: string } {
  const s = text.trimStart();

  // 1) 英文 AM/PM：2pm / 2:30pm / 9am（先於 24h HH:MM，避免 "2:30pm" 被切成 HH:MM + "pm"）
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)\s*(.*)/s);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const period = ampm[3].toLowerCase();
    if (period === 'pm' && h < 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return { dueTime: `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`, rest: ampm[4] };
    }
  }

  // 2) 標準 24h：14:00 / 9:30 / 09:30
  const hhmm = s.match(/^(\d{1,2}):(\d{2})\s*(.*)/s);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10);
    const m = parseInt(hhmm[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return { dueTime: `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`, rest: hhmm[3] };
    }
  }

  // 3) 中文：下午/上午/早上/晚上/中午 + 數字或國字 + 點 + [半 / 分]
  //    例：下午兩點、下午 2 點、下午兩點半、晚上 8 點 30 分、中午 12 點、早上九點
  const cn = s.match(/^(凌晨|早上|上午|中午|下午|晚上)\s*([一二三四五六七八九十百零兩\d]+)\s*(?:點|時)\s*(半|[一二三四五六七八九十百零兩\d]+)?\s*(?:分)?\s*(.*)/s);
  if (cn) {
    const period = cn[1];
    const hourStr = cn[2];
    const minStr = cn[3];
    const hRaw = chineseNumToInt(hourStr);
    const mRaw = minStr === '半' ? 30 : (minStr ? chineseNumToInt(minStr) : 0);

    if (hRaw !== null && mRaw !== null && hRaw >= 0 && hRaw <= 23 && mRaw >= 0 && mRaw <= 59) {
      let h = hRaw;
      const m = mRaw;
      // 語義調整 AM/PM
      if (period === '下午' && h < 12) h += 12;
      else if (period === '晚上' && h < 12) h += 12;
      else if (period === '中午' && h !== 12) h = 12;  // 「中午 12 點」 → 12:00
      else if ((period === '凌晨' || period === '早上' || period === '上午') && h === 12) h = 0;

      return { dueTime: `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`, rest: cn[4] };
    }
  }

  // 4) 沒前綴的中文：3 點 / 兩點半 / 九點二十
  const cnNoPeriod = s.match(/^([一二三四五六七八九十百零兩\d]+)\s*(?:點|時)\s*(半|[一二三四五六七八九十百零兩\d]+)?\s*(?:分)?\s*(.*)/s);
  if (cnNoPeriod) {
    const hourStr = cnNoPeriod[1];
    const minStr = cnNoPeriod[2];
    const h = chineseNumToInt(hourStr);
    const m = minStr === '半' ? 30 : (minStr ? chineseNumToInt(minStr) : 0);

    if (h !== null && m !== null && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return { dueTime: `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`, rest: cnNoPeriod[3] };
    }
  }

  return { rest: text };
}

/**
 * 把「兩」「十」「二十」「15」「零」等轉成整數。解析失敗回傳 null。
 */
function chineseNumToInt(s: string): number | null {
  if (!s) return null;
  // 純阿拉伯數字
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  const map: Record<string, number> = {
    '零': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  };

  // 單字：一 / 二 / 三 / ... / 十
  if (s.length === 1 && s in map) return map[s];

  // 兩位：十一 (11) / 二十 (20) / 二十五 (25)
  if (s.startsWith('十')) {
    const rest = s.slice(1);
    return rest ? 10 + (map[rest] ?? NaN) : 10;
  }
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a ? map[a] : 1;
    const ones = b ? map[b] ?? 0 : 0;
    if (tens === undefined || tens === null) return null;
    return tens * 10 + ones;
  }

  return null;
}
