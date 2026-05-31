import fs from 'fs';
import path from 'path';
import { config } from '../config';

/**
 * 持久化「最後一次成功知識庫同步」的時間戳。
 *
 * 用途：bot 重啟（部署 / OOM 重啟 / Azure 維護）會把記憶體裡的 lastSyncTime 重置，
 * 導致 setInterval 要等 1 小時才跑第一次同步、且第一次跑全量浪費 token。
 *
 * 啟動時讀回 lastSyncTime → 如果 stale（> 70 分鐘）→ 立即補跑增量同步，
 * 確保新加入 KM / Google Docs / Notion 的內容最多 5~10 分鐘可被搜到。
 *
 * 為什麼放在 C:\home\data\：deploy 不會清，跨重啟保留。
 */

interface SyncState {
  lastSyncAt: string; // ISO timestamp
}

function ensureDir(): void {
  const dir = path.dirname(config.syncStatePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getLastSyncAt(): Date | null {
  const p = config.syncStatePath;
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SyncState;
    if (!raw.lastSyncAt) return null;
    return new Date(raw.lastSyncAt);
  } catch (err: any) {
    console.error('[SyncState] 讀取狀態檔失敗:', err.message);
    return null;
  }
}

export function setLastSyncAt(when: Date = new Date()): void {
  ensureDir();
  const p = config.syncStatePath;
  try {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ lastSyncAt: when.toISOString() }, null, 2));
    fs.renameSync(tmp, p);
  } catch (err: any) {
    console.error('[SyncState] 寫入狀態檔失敗:', err.message);
  }
}

/**
 * 判斷 bot 啟動時是否需要立即補跑同步：
 *  - 從沒同步過 → 補跑
 *  - 上次同步 > 70 分鐘前（一個 cron 間隔 + 10 分鐘容忍）→ 補跑
 *  - 否則跳過，等下一個 setInterval
 */
export function shouldCatchUpMissedSync(now: Date = new Date()): boolean {
  const lastSync = getLastSyncAt();
  if (!lastSync) {
    console.log('[SyncState] 從沒同步過，啟動後補跑');
    return true;
  }
  const minutesSince = (now.getTime() - lastSync.getTime()) / (1000 * 60);
  if (minutesSince > 70) {
    console.log(`[SyncState] 上次同步 ${lastSync.toISOString()} 距今 ${minutesSince.toFixed(1)} 分鐘，啟動後補跑`);
    return true;
  }
  console.log(`[SyncState] 上次同步 ${lastSync.toISOString()} 距今 ${minutesSince.toFixed(1)} 分鐘，跳過啟動補跑`);
  return false;
}
