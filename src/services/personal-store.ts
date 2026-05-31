import fs from 'fs';
import path from 'path';
import { config } from '../config';

// ── 資料型別 ──

/**
 * 圖片附件：儲存在 Azure Blob Storage 的單一檔案參照
 */
export interface BlobImage {
  blobName: string;        // Blob 檔名（uuid.jpg）
  contentType: string;     // image/jpeg 等
  uploadedAt: string;      // ISO timestamp
  size: number;            // bytes
}

export interface Note {
  id: number;
  content: string;
  createdAt: string;
  published: boolean;
  publishedTo?: string; // 'notion' | 'km' | 'gdocs'
  images?: BlobImage[];
}

export interface Reminder {
  id: number;
  content: string;
  dueDate: string | null;     // ISO date string (YYYY-MM-DD) or null
  dueTime?: string;           // HH:MM (24h), 有值代表精準時間提醒（會在到期前 30 分鐘單獨推送）
  completed: boolean;
  createdAt: string;
  notifiedAt?: string;        // 精準時間提醒已推送的時間戳（ISO），避免重複推
  images?: BlobImage[];
}

/**
 * 記錄用戶上一則 RAG 問答的上下文，用來處理「這兩份」「那份」之類代名詞。
 */
export interface LastRagContext {
  question: string;
  answeredAt: string;
  sources: Array<{
    sourceType: 'km_system' | 'google_docs' | 'notion';
    sourceId: string;   // 文件/頁面的唯一 ID（依 sourceType 可能是 km pageId、gdoc id、notion page id）
    title: string;
    url?: string;
    description?: string;  // google doc 的話是 doc id（跟 appendToGoogleDoc 需要的一致）
    path?: string;         // km/notion 路徑
  }>;
}

export interface PersonalData {
  userId: string;
  userName: string;
  notes: Note[];
  reminders: Reminder[];
  lastRagContext?: LastRagContext;
}

// ── 存取方法 ──

function ensureDir(): void {
  const dir = config.personalAssistant.dataDir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function filePath(userId: string): string {
  // Teams user ID 可能含有特殊字元，用 base64 安全轉換
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(config.personalAssistant.dataDir, `${safeId}.json`);
}

export function load(userId: string): PersonalData {
  ensureDir();
  const fp = filePath(userId);
  if (fs.existsSync(fp)) {
    const raw = fs.readFileSync(fp, 'utf-8');
    return JSON.parse(raw) as PersonalData;
  }
  return { userId, userName: '', notes: [], reminders: [] };
}

/**
 * 儲存/讀取 lastRagContext — 用於跨訊息的對話記憶
 * （例如用戶說「這兩份」，bot 可以 resolve 到上次 RAG 回答的 sources）
 */
export function setLastRagContext(
  userId: string,
  userName: string,
  context: LastRagContext,
): void {
  const data = load(userId);
  data.userName = userName;
  data.lastRagContext = context;
  save(data);
}

export function getLastRagContext(userId: string): LastRagContext | undefined {
  return load(userId).lastRagContext;
}

function save(data: PersonalData): void {
  ensureDir();
  const fp = filePath(data.userId);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
}

// ── 筆記操作 ──

export function addNote(userId: string, userName: string, content: string): Note {
  const data = load(userId);
  data.userName = userName;
  const nextId = data.notes.length > 0 ? Math.max(...data.notes.map((n) => n.id)) + 1 : 1;
  const note: Note = {
    id: nextId,
    content,
    createdAt: new Date().toISOString(),
    published: false,
  };
  data.notes.push(note);
  save(data);
  return note;
}

export function listNotes(userId: string, limit = 10): Note[] {
  const data = load(userId);
  return data.notes.slice(-limit).reverse(); // 最新的在前
}

export function getNote(userId: string, noteId: number): Note | undefined {
  const data = load(userId);
  return data.notes.find((n) => n.id === noteId);
}

export function markNotePublished(userId: string, noteId: number, platform: string): void {
  const data = load(userId);
  const note = data.notes.find((n) => n.id === noteId);
  if (note) {
    note.published = true;
    note.publishedTo = platform;
    save(data);
  }
}

/**
 * 刪除指定筆記。回傳被刪除的筆記（若找到），否則 null。
 * 注意：呼叫端（通常是 teams-bot.ts）負責在刪除後呼叫 blob-storage.deleteImages(removed.images)，
 * 本 store 層不直接觸碰 Blob 避免循環相依
 */
export function deleteNote(userId: string, noteId: number): Note | null {
  const data = load(userId);
  const idx = data.notes.findIndex((n) => n.id === noteId);
  if (idx < 0) return null;
  const [removed] = data.notes.splice(idx, 1);
  save(data);
  return removed;
}

/**
 * 把圖片（已上傳至 Blob）綁定到一則筆記或提醒
 * type='note' 或 'reminder'；id = 對應的 noteId/reminderId
 * 超過上限（5 張）會丟錯誤
 */
export function attachImages(
  userId: string,
  type: 'note' | 'reminder',
  itemId: number,
  images: BlobImage[],
): { success: true; totalCount: number } | { success: false; error: string } {
  const data = load(userId);
  const target = type === 'note'
    ? data.notes.find((n) => n.id === itemId)
    : data.reminders.find((r) => r.id === itemId);

  if (!target) {
    return { success: false, error: `找不到 ${type === 'note' ? '筆記' : '提醒'} #${itemId}` };
  }

  const existing = target.images || [];
  const total = existing.length + images.length;
  const MAX = 5;
  if (total > MAX) {
    return { success: false, error: `這則${type === 'note' ? '筆記' : '提醒'}已經有 ${existing.length} 張圖，再加 ${images.length} 張會超過 ${MAX} 張上限` };
  }

  target.images = [...existing, ...images];
  save(data);
  return { success: true, totalCount: target.images.length };
}

/**
 * 發布 / 完成 / 刪除後清除筆記的 images 欄位
 * （Blob 本體刪除由 caller 處理；這裡只更新 JSON）
 */
export function clearNoteImages(userId: string, noteId: number): void {
  const data = load(userId);
  const note = data.notes.find((n) => n.id === noteId);
  if (note && note.images && note.images.length > 0) {
    delete note.images;
    save(data);
  }
}

export function clearReminderImages(userId: string, reminderId: number): void {
  const data = load(userId);
  const reminder = data.reminders.find((r) => r.id === reminderId);
  if (reminder && reminder.images && reminder.images.length > 0) {
    delete reminder.images;
    save(data);
  }
}

/**
 * 取得最近一則筆記（用於「我剛記了 X，接著拖圖上去」的自動關聯）
 * 要求：createdAt 在 5 分鐘內、且尚未發布
 */
export function getLatestRecentNote(userId: string, withinMinutes = 5): Note | undefined {
  const data = load(userId);
  if (data.notes.length === 0) return undefined;
  const last = data.notes[data.notes.length - 1];
  const ageMs = Date.now() - new Date(last.createdAt).getTime();
  if (ageMs > withinMinutes * 60 * 1000) return undefined;
  if (last.published) return undefined;
  return last;
}

/**
 * 取得最近一則未完成提醒（用於「拖圖上去就附到這則提醒」）
 * 要求：createdAt 在 5 分鐘內、尚未完成
 */
export function getLatestRecentReminder(userId: string, withinMinutes = 5): Reminder | undefined {
  const data = load(userId);
  const pending = data.reminders.filter((r) => !r.completed);
  if (pending.length === 0) return undefined;
  const last = pending[pending.length - 1];
  const ageMs = Date.now() - new Date(last.createdAt).getTime();
  if (ageMs > withinMinutes * 60 * 1000) return undefined;
  return last;
}

// ── 提醒操作 ──

export function addReminder(
  userId: string,
  userName: string,
  content: string,
  dueDate: string | null = null,
  dueTime?: string,
): Reminder {
  const data = load(userId);
  data.userName = userName;
  const nextId = data.reminders.length > 0 ? Math.max(...data.reminders.map((r) => r.id)) + 1 : 1;
  const reminder: Reminder = {
    id: nextId,
    content,
    dueDate,
    ...(dueTime ? { dueTime } : {}),
    completed: false,
    createdAt: new Date().toISOString(),
  };
  data.reminders.push(reminder);
  save(data);
  return reminder;
}

/**
 * 找到所有需要「精準時間提醒」推送的 reminders。
 * 條件：
 *   - 未完成
 *   - 有 dueDate + dueTime
 *   - 「dueDate + dueTime - 30 min」落在 [now-leadSlackMs, now+leadSlackMs] 區間內
 *   - notifiedAt 為空（還沒推過）
 *
 * 注意：leadSlackMs 設 5 分鐘（與 cron 週期對應），寬鬆一點避免抓漏。
 */
export function listUpcomingReminders(
  userId: string,
  now: Date = new Date(),
  leadMinutes = 30,
  slackMinutes = 5,
): Reminder[] {
  const data = load(userId);
  return data.reminders.filter((r) => {
    if (r.completed) return false;
    if (!r.dueDate || !r.dueTime) return false;
    if (r.notifiedAt) return false;

    // 組出到期的絕對時間
    const [hh, mm] = r.dueTime.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return false;

    // dueDate 格式是 YYYY-MM-DD，在本地時區組出 Date
    const [y, m, d] = r.dueDate.split('-').map(Number);
    const due = new Date(y, m - 1, d, hh, mm, 0);
    const notifyAt = due.getTime() - leadMinutes * 60 * 1000;

    // 比對現在是否落在 [notifyAt - slack, notifyAt + slack] 內
    const slackMs = slackMinutes * 60 * 1000;
    return now.getTime() >= notifyAt - slackMs && now.getTime() <= notifyAt + slackMs;
  });
}

/**
 * 標記一則 reminder 已經推送過（寫 notifiedAt = now）
 */
export function markReminderNotified(userId: string, reminderId: number): void {
  const data = load(userId);
  const r = data.reminders.find((x) => x.id === reminderId);
  if (r) {
    r.notifiedAt = new Date().toISOString();
    save(data);
  }
}

export function completeReminder(userId: string, reminderId: number): Reminder | null {
  const data = load(userId);
  const reminder = data.reminders.find((r) => r.id === reminderId);
  if (!reminder) return null;
  reminder.completed = true;
  save(data);
  return reminder;
}

export function listPendingReminders(userId: string): Reminder[] {
  const data = load(userId);
  return data.reminders.filter((r) => !r.completed);
}

export function listDueReminders(userId: string): Reminder[] {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const data = load(userId);
  return data.reminders.filter((r) => {
    if (r.completed) return false;

    // 有精準時間的 reminder，只要已經推過（notifiedAt 已設）就不納入總覽
    // 避免「14:00 的會議，13:30 被精準推送了一次 + 14:00 總覽又推一次」
    if (r.dueTime && r.notifiedAt) return false;

    return r.dueDate === null || r.dueDate <= today;
  });
}

// ── 搜尋 ──

export interface SearchResult {
  type: 'note' | 'reminder';
  id: number;
  content: string;
  createdAt: string;
  extra?: string; // dueDate or publishedTo
}

export function searchAll(userId: string, keyword: string, limit = 10): SearchResult[] {
  const data = load(userId);
  const kw = keyword.toLowerCase();
  const results: SearchResult[] = [];

  for (const note of data.notes) {
    if (note.content.toLowerCase().includes(kw)) {
      results.push({
        type: 'note',
        id: note.id,
        content: note.content,
        createdAt: note.createdAt,
        extra: note.publishedTo,
      });
    }
  }

  for (const reminder of data.reminders) {
    if (reminder.content.toLowerCase().includes(kw)) {
      results.push({
        type: 'reminder',
        id: reminder.id,
        content: reminder.content,
        createdAt: reminder.createdAt,
        extra: reminder.dueDate || undefined,
      });
    }
  }

  // 按時間倒序
  results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return results.slice(0, limit);
}

// ── 工具：列出所有有資料的用戶 ──

export function listAllUserIds(): string[] {
  ensureDir();
  const dir = config.personalAssistant.dataDir;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}
