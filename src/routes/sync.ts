import { Router, Request, Response } from 'express';
import { config } from '../config';
import { syncKnowledgeBase } from '../etl/sync';
import { sendDailyReminders } from '../bot/proactive';
import { adapter } from './teamsbot';
import { setLastSyncAt } from '../services/sync-state';

const router = Router();

let syncing = false;

/**
 * POST /api/sync
 * Wiki.js Webhook 觸發知識庫同步
 *
 * Wiki.js 設定：
 *   Administration → Webhooks → Add
 *   URL: https://<app-domain>/api/sync?token=<SYNC_SECRET>
 *   Events: pages:updated, pages:created, pages:deleted
 */
router.post('/sync', async (req: Request, res: Response) => {
  // 驗證 token
  const token = req.query.token || req.headers['x-sync-token'];
  if (token !== config.syncSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // 防止同時多次同步
  if (syncing) {
    res.json({ status: 'already_syncing', message: '同步正在進行中，請稍後再試' });
    return;
  }

  syncing = true;
  console.log('[Sync] Webhook 觸發同步...');

  // 非阻塞：先回應 200，背景執行同步
  res.json({ status: 'accepted', message: '同步已開始' });

  try {
    const result = await syncKnowledgeBase();
    setLastSyncAt(); // 持久化最後同步時間，重啟後可作為增量同步基準
    console.log(`[Sync] Webhook 同步完成: ${result.pagesProcessed} 篇文件, ${result.chunksCreated} 個片段`);
  } catch (error: any) {
    console.error('[Sync] Webhook 同步失敗:', error.message);
  } finally {
    syncing = false;
  }
});

/**
 * GET /api/sync/status
 * 查看同步狀態
 */
router.get('/sync/status', (req: Request, res: Response) => {
  const token = req.query.token || req.headers['x-sync-token'];
  if (token !== config.syncSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.json({
    syncing,
    knowledgeBase: require('../services/vector-store').vectorStore.stats(),
  });
});

/**
 * POST /api/trigger-reminder
 * 手動觸發每日提醒推送（用 sync secret 驗證，跟 sync 共用 token）
 * 可用來測試提醒有沒有正確推送、或在 cron 失效時手動補發
 */
router.post('/trigger-reminder', async (req: Request, res: Response) => {
  const token = req.query.token || req.headers['x-sync-token'];
  if (token !== config.syncSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  console.log('[API] 手動觸發每日提醒推送');
  res.json({ status: 'accepted', message: '正在執行每日提醒推送...' });

  try {
    await sendDailyReminders(adapter);
    console.log('[API] 手動提醒推送完成');
  } catch (error: any) {
    console.error('[API] 手動提醒推送失敗:', error.message);
  }
});

export default router;
