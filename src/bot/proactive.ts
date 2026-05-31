import fs from 'fs';
import path from 'path';
import {
  TurnContext,
  ConversationReference,
  BotFrameworkAdapter,
  CardFactory,
  MessageFactory,
} from 'botbuilder';
import { config } from '../config';
import * as store from '../services/personal-store';
import { createDailyReminderCard } from './personal-cards';
import { trackEvent, trackException } from '../services/telemetry';
import { setLastFiredAt as setDailyReminderFiredAt } from '../services/daily-reminder-state';

// ── ConversationReference 管理 ──

let conversationRefs: Record<string, Partial<ConversationReference>> = {};

function loadConversationRefs(): void {
  const fp = config.personalAssistant.conversationRefsPath;
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      conversationRefs = JSON.parse(raw);
      console.log(`[Proactive] 載入 ${Object.keys(conversationRefs).length} 個 ConversationReference`);
    } catch {
      conversationRefs = {};
    }
  }
}

function saveConversationRefs(): void {
  const fp = config.personalAssistant.conversationRefsPath;
  try {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(conversationRefs, null, 2), 'utf-8');
  } catch (err: any) {
    console.error('[Proactive] 寫入 conversation-refs 失敗:', err.message);
  }
}

/**
 * 從 TurnContext 儲存 ConversationReference
 * 每次收到 1:1 訊息時呼叫
 */
export function saveConversationRef(context: TurnContext): void {
  const ref = TurnContext.getConversationReference(context.activity);
  const userId = context.activity.from.id;
  if (userId) {
    conversationRefs[userId] = ref;
    saveConversationRefs();
  }
}

/**
 * 啟動時載入已儲存的 ConversationReference
 */
export function initProactive(): void {
  loadConversationRefs();
}

// ── 每日提醒推送 ──

/**
 * 掃描所有用戶，推送未完成提醒
 * 由 node-cron 定時呼叫
 */
export async function sendDailyReminders(adapter: BotFrameworkAdapter): Promise<void> {
  console.log('[Proactive] 開始每日提醒推送...');
  trackEvent('DailyReminderTriggered');

  // ⚠️ 重要：每次推送前從磁碟重新載入 conversationRefs
  // 因為 App Service 有多台 instance，只有收過訊息的 instance 記憶體才有 ref，
  // 其他 instance 如果不重新載入就會「找不到用戶」而跳過。
  loadConversationRefs();

  const userIds = store.listAllUserIds();
  let sentCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  console.log(`[Proactive] 找到 ${userIds.length} 位用戶`);

  for (const safeUserId of userIds) {
    // 找出到期的提醒
    const dueReminders = store.listDueReminders(safeUserId);
    if (dueReminders.length === 0) {
      console.log(`[Proactive] ${safeUserId}: 沒有到期提醒，跳過`);
      continue;
    }

    // 取得用戶資料（取 userName）
    const data = store.load(safeUserId);

    // 找到對應的 ConversationReference
    const ref = findConversationRef(safeUserId);
    if (!ref) {
      console.log(`[Proactive] 找不到用戶 ${safeUserId} 的 ConversationReference，跳過`);
      skipCount++;
      trackEvent('DailyReminderSkipped', { safeUserId, reason: 'no_conversation_ref', dueCount: dueReminders.length });
      continue;
    }

    try {
      await adapter.continueConversation(
        ref as ConversationReference,
        async (turnContext) => {
          const card = createDailyReminderCard(data.userName || '同事', dueReminders);
          const activity = MessageFactory.attachment(
            CardFactory.adaptiveCard(card),
          );
          await turnContext.sendActivity(activity);
        },
      );
      sentCount++;
      console.log(`[Proactive] 已推送提醒給 ${data.userName || safeUserId} (${dueReminders.length} 項)`);
      trackEvent('DailyReminderSent', { userName: data.userName, safeUserId, dueCount: dueReminders.length });
    } catch (error: any) {
      errorCount++;
      console.error(`[Proactive] 推送失敗 (${safeUserId}):`, error.message);
      trackEvent('DailyReminderFailed', { safeUserId, userName: data.userName, error: error.message });
      trackException(error, { context: 'sendDailyReminders', safeUserId });
    }
  }

  console.log(`[Proactive] 每日提醒完成：${sentCount} 成功, ${skipCount} 跳過, ${errorCount} 失敗`);
  trackEvent('DailyReminderCompleted', { sentCount, skipCount, errorCount, totalUsers: userIds.length });

  // 更新最後成功觸發時間（即使 0 個用戶到期也算「跑過」，避免重啟後又補跑）
  setDailyReminderFiredAt();
}

// ── 精準時間提醒（到期前 30 分鐘單獨推送） ──

/**
 * 每 5 分鐘掃一次，推送「30 分鐘後到期」的提醒。
 * 每則提醒只推一次（notifiedAt 標記），即使 cron 在區間內多次掃到也不會重複。
 */
export async function sendUpcomingReminders(adapter: BotFrameworkAdapter): Promise<void> {
  loadConversationRefs();  // 跨 instance 必須重新載入

  const userIds = store.listAllUserIds();
  let sentCount = 0;

  for (const safeUserId of userIds) {
    const upcoming = store.listUpcomingReminders(safeUserId);
    if (upcoming.length === 0) continue;

    const data = store.load(safeUserId);
    const ref = findConversationRef(safeUserId);
    if (!ref) {
      console.log(`[Proactive] 精準提醒：找不到 ${safeUserId} 的 ConversationReference，跳過`);
      continue;
    }

    for (const reminder of upcoming) {
      try {
        await adapter.continueConversation(
          ref as ConversationReference,
          async (turnContext) => {
            const card = createUpcomingReminderCard(reminder);
            await turnContext.sendActivity(
              MessageFactory.attachment(CardFactory.adaptiveCard(card)),
            );
          },
        );
        store.markReminderNotified(safeUserId, reminder.id);
        sentCount++;
        console.log(`[Proactive] 精準提醒已推送：${data.userName} #${reminder.id} (${reminder.dueDate} ${reminder.dueTime})`);
        trackEvent('UpcomingReminderSent', {
          userName: data.userName,
          reminderId: reminder.id,
          dueDate: reminder.dueDate || undefined,
          dueTime: reminder.dueTime,
        });
      } catch (error: any) {
        console.error(`[Proactive] 精準提醒推送失敗 (${safeUserId}, #${reminder.id}):`, error.message);
        trackException(error, { context: 'sendUpcomingReminders', safeUserId, reminderId: String(reminder.id) });
      }
    }
  }

  if (sentCount > 0) {
    console.log(`[Proactive] 精準提醒完成：推送 ${sentCount} 則`);
  }
}

/**
 * 單則精準時間提醒卡片（強調「30 分鐘後」）
 */
function createUpcomingReminderCard(reminder: store.Reminder): object {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: `⏰ 30 分鐘後到期`,
        weight: 'Bolder',
        size: 'Medium',
        color: 'Accent',
      },
      {
        type: 'TextBlock',
        text: reminder.content,
        wrap: true,
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: `📅 ${reminder.dueDate} ${reminder.dueTime}`,
        size: 'Small',
        color: 'Light',
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: '☐ 完成',
        style: 'positive',
        data: { action: 'complete_reminder', reminderId: reminder.id },
      },
    ],
  };
}

/**
 * 根據 safeUserId 找到對應的 ConversationReference
 */
function findConversationRef(safeUserId: string): Partial<ConversationReference> | null {
  // 直接查找
  if (conversationRefs[safeUserId]) {
    return conversationRefs[safeUserId];
  }

  // 嘗試用 safeUserId 反向匹配原始 userId
  for (const [originalId, ref] of Object.entries(conversationRefs)) {
    const safe = originalId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (safe === safeUserId) {
      return ref;
    }
  }

  return null;
}
