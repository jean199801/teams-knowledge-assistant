import fs from 'fs';
import path from 'path';
import { config } from '../config';

/**
 * 持久化「最後一次成功推送每日提醒」的時間戳。
 *
 * 用途：bot 在 cron 觸發時間點重啟時，會錯過該次 cron（node-cron 是 in-process）。
 * 啟動後檢查：今天最近一次預定觸發時間（9 / 14 / 17）有沒有比 lastFiredAt 還新？
 * 若有 → 補跑一次。
 *
 * 為什麼放在 C:\home\data\：deploy 不會清，跨重啟保留。
 */

interface DailyReminderState {
  lastFiredAt: string; // ISO timestamp
}

function ensureDir(): void {
  const dir = path.dirname(config.personalAssistant.dailyReminderStatePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getLastFiredAt(): Date | null {
  const p = config.personalAssistant.dailyReminderStatePath;
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as DailyReminderState;
    if (!raw.lastFiredAt) return null;
    return new Date(raw.lastFiredAt);
  } catch (err: any) {
    console.error('[DailyReminderState] 讀取狀態檔失敗:', err.message);
    return null;
  }
}

export function setLastFiredAt(when: Date = new Date()): void {
  ensureDir();
  const p = config.personalAssistant.dailyReminderStatePath;
  try {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ lastFiredAt: when.toISOString() }, null, 2));
    fs.renameSync(tmp, p);
  } catch (err: any) {
    console.error('[DailyReminderState] 寫入狀態檔失敗:', err.message);
  }
}

/**
 * 解析 cron 字串裡的「小時清單」（例：'0 9,14,17 * * 1-5' → [9, 14, 17]）
 * 只支援我們實際使用的格式，不打算處理任意 cron 表達式。
 */
function parseCronHours(cronExpr: string): number[] {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return [];
  const hourField = parts[1];
  const hours: number[] = [];
  for (const seg of hourField.split(',')) {
    const n = parseInt(seg, 10);
    if (!isNaN(n) && n >= 0 && n <= 23) hours.push(n);
  }
  return hours;
}

/**
 * 取得「今天最近一次已過的預定觸發時間」（在當前時間之前）。
 * 只考慮週一~週五（cron 的 1-5）。如果今天是週末或還沒到第一個排程，回傳 null。
 *
 * @param now 當前時間（可注入測試）
 * @returns 最近一次已過的 cron 觸發時間
 */
export function getMostRecentScheduledFireBefore(now: Date = new Date()): Date | null {
  // 只在週一~週五（getDay 0=Sun, 1=Mon ... 5=Fri, 6=Sat）
  const dow = now.getDay();
  if (dow === 0 || dow === 6) return null;

  const hours = parseCronHours(config.personalAssistant.dailyReminderCron).sort((a, b) => a - b);
  if (hours.length === 0) return null;

  const currentHour = now.getHours();
  const currentMin = now.getMinutes();

  // 找出所有今天「已經過」的排程小時（h <= currentHour，且 cron 是 0 分整點，所以同小時內 currentMin >= 0 即算過）
  const passedHours = hours.filter((h) => h < currentHour || (h === currentHour && currentMin >= 0 && now.getSeconds() >= 0 && now.getMilliseconds() >= 0));
  // 修正：如果是「同小時但才剛過 0 分」也應該包含
  const realPassedHours = hours.filter((h) => {
    if (h < currentHour) return true;
    if (h === currentHour) {
      // 該小時的 0 分鐘 0 秒已過
      return currentMin > 0 || (currentMin === 0 && now.getSeconds() > 0);
    }
    return false;
  });

  if (realPassedHours.length === 0) return null;

  const mostRecentHour = Math.max(...realPassedHours);
  const result = new Date(now);
  result.setHours(mostRecentHour, 0, 0, 0);
  return result;
}

/**
 * 判斷是否需要補跑「漏掉的每日提醒 cron」
 * 條件：
 *   1. 今天有已過的排程時間（週一~五的 9 / 14 / 17）
 *   2. lastFiredAt 比最近一次排程時間還早（包括從來沒跑過的情況）
 *   3. 排程時間離當前不超過 4 小時（避免大半夜重啟也補跑造成騷擾）
 */
export function shouldCatchUpMissedReminder(now: Date = new Date()): boolean {
  const mostRecentScheduled = getMostRecentScheduledFireBefore(now);
  if (!mostRecentScheduled) return false;

  // 4 小時保護：避免凌晨重啟補跑前一個工作日 17:00 的提醒
  const hoursSinceScheduled = (now.getTime() - mostRecentScheduled.getTime()) / (1000 * 60 * 60);
  if (hoursSinceScheduled > 4) {
    console.log(`[DailyReminderState] 最近排程 ${mostRecentScheduled.toISOString()} 已過 ${hoursSinceScheduled.toFixed(1)} 小時，太久不補`);
    return false;
  }

  const lastFired = getLastFiredAt();
  if (!lastFired) {
    console.log('[DailyReminderState] 從沒跑過，補跑');
    return true;
  }

  if (lastFired < mostRecentScheduled) {
    console.log(`[DailyReminderState] 最近排程 ${mostRecentScheduled.toISOString()} 晚於 lastFired ${lastFired.toISOString()}，補跑`);
    return true;
  }

  return false;
}
