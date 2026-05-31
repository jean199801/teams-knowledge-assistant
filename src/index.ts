import 'dotenv/config';
// ⚠️ 遙測要在其他 import 之前就 init，讓 auto-instrumentation 可以 patch 到後續的 http/express/mssql 等模組
import { initTelemetry } from './services/telemetry';
initTelemetry();

import express from 'express';
import cors from 'cors';
import path from 'path';
import cron from 'node-cron';
import { config } from './config';
import { vectorStore } from './services/vector-store';
import { shouldCatchUpMissedReminder } from './services/daily-reminder-state';
import { getLastSyncAt, setLastSyncAt, shouldCatchUpMissedSync } from './services/sync-state';
import { syncKnowledgeBase } from './etl/sync';
import chatRouter from './routes/chat';
import teamsBotRouter, { adapter } from './routes/teamsbot';
import syncRouter from './routes/sync';
import { initProactive, sendDailyReminders, sendUpcomingReminders } from './bot/proactive';
import fs from 'fs';

async function main() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // 靜態檔案（Web Chat UI，可選）
  app.use(express.static(path.join(__dirname, '..', 'web')));

  // API 路由
  app.use('/api', chatRouter);
  app.use('/api', teamsBotRouter);
  app.use('/api', syncRouter);

  // 首頁導向 Web Chat（若有 web/ 目錄）
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
  });

  // 確保個人助手資料目錄存在
  if (!fs.existsSync(config.personalAssistant.dataDir)) {
    fs.mkdirSync(config.personalAssistant.dataDir, { recursive: true });
  }

  // 載入向量資料庫
  await vectorStore.load();

  // 載入主動推送的 ConversationReference
  initProactive();

  // 啟動伺服器
  app.listen(config.port, () => {
    const stats = vectorStore.stats();
    const teamsEnabled = !!(config.teams.appId && config.teams.appPassword);
    console.log('\n========================================');
    console.log(`  ${config.botDisplayName}`);
    console.log(`  http://localhost:${config.port}`);
    console.log(`  知識庫: ${stats.total} 個片段`);
    console.log(`  Teams Bot: ${teamsEnabled ? '✅ 已啟用' : '⚠️ 未設定 (MICROSOFT_APP_ID/PASSWORD)'}`);
    if (teamsEnabled) {
      console.log(`    Endpoint: http://localhost:${config.port}/api/messages`);
    }
    console.log('  自動同步: 每 1 小時');
    console.log(`  每日提醒: ${config.personalAssistant.dailyReminderCron}`);
    console.log(`  個人資料: ${config.personalAssistant.dataDir}`);
    console.log('========================================\n');
  });

  // 定時自動同步：每 1 小時檢查知識來源是否有更新
  const SYNC_INTERVAL = 60 * 60 * 1000; // 1 小時
  // 從持久化檔案讀取上次同步時間（部署 / 重啟後仍保留），用於跑增量同步而不是全量重 embed
  let lastSyncTime: Date | undefined = getLastSyncAt() || undefined;

  // 啟動補跑：兩種觸發條件
  //   1. 向量庫為空（新環境 / 持久化檔案被誤刪）→ 全量同步
  //   2. 上次同步距今 > 70 分鐘（部署 / 重啟錯過 cron 窗口）→ 增量同步
  // 兩者都延遲 60 秒，讓 web server 先準備好，避免啟動爭資源
  const kbEmpty = vectorStore.stats().total === 0;
  const syncStale = shouldCatchUpMissedSync();
  if (kbEmpty || syncStale) {
    const reason = kbEmpty ? '知識庫為空，全量同步' : '上次同步太久，增量補跑';
    console.log(`[StartupSync] ${reason}，60 秒後啟動...`);
    setTimeout(async () => {
      console.log(`[StartupSync] 開始補跑（${reason}）...`);
      try {
        const result = await syncKnowledgeBase(kbEmpty ? undefined : lastSyncTime);
        lastSyncTime = new Date();
        setLastSyncAt(lastSyncTime);
        console.log(`[StartupSync] 完成: ${result.pagesProcessed} 篇文件, ${result.chunksCreated} 個片段`);
      } catch (error: any) {
        console.error('[StartupSync] 同步失敗:', error.message);
      }
    }, 60 * 1000);
  } else {
    console.log(`[StartupSync] 知識庫 ${vectorStore.stats().total} 個片段、上次同步在容忍範圍，跳過啟動補跑`);
  }

  setInterval(async () => {
    console.log('[AutoSync] 開始定時同步...');
    try {
      const result = await syncKnowledgeBase(lastSyncTime);
      lastSyncTime = new Date();
      setLastSyncAt(lastSyncTime);
      console.log(`[AutoSync] 完成: ${result.pagesProcessed} 篇文件, ${result.chunksCreated} 個片段`);
    } catch (error: any) {
      console.error('[AutoSync] 同步失敗:', error.message);
    }
  }, SYNC_INTERVAL);

  // 每日總覽提醒推送
  //
  // ⚠️ 為什麼不直接用 cron.schedule(DAILY_REMINDER_CRON)：
  // 實測 node-cron 的整點排程在長時間運行的 process 中會「間歇性失效」，
  // 但短週期 cron（如 */5）穩定 —— 不可靠。
  // 改用輪詢的安全網：每次檢查「最近一個已過的排程時段，lastFired 有沒有記到」，
  // 沒記到就補推。用 lastFired 比對避免重複，最多延遲 10 分鐘內一定補上。
  const checkAndFireDailyReminders = async () => {
    if (!shouldCatchUpMissedReminder()) return;
    console.log('[DailyReminder] 輪詢偵測到該推但還沒推，執行推送...');
    try {
      await sendDailyReminders(adapter); // 內部結尾會 setLastFiredAt，避免重複
    } catch (error: any) {
      console.error('[DailyReminder] 推送失敗:', error.message);
    }
  };

  // 啟動後 30 秒先檢查一次（涵蓋「在排程時間點重啟」的情況）
  setTimeout(checkAndFireDailyReminders, 30 * 1000);
  // 之後每 10 分鐘輪詢一次
  setInterval(checkAndFireDailyReminders, 10 * 60 * 1000);
  console.log('[Cron] 每日提醒安全網已啟動（每 10 分鐘輪詢）');

  // 精準時間提醒（每 5 分鐘掃一次，推送 30 分鐘後到期的項目）
  cron.schedule('*/5 * * * *', async () => {
    try {
      await sendUpcomingReminders(adapter);
    } catch (error: any) {
      console.error('[UpcomingReminder] 推送失敗:', error.message);
    }
  });
  console.log('[Cron] 精準時間提醒已排程（每 5 分鐘掃描）');
}

main().catch(console.error);
