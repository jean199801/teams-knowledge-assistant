import { Router, Request, Response } from 'express';
import { BotFrameworkAdapter } from 'botbuilder';
import { config } from '../config';
import { KnowledgeAssistantBot } from '../bot/teams-bot';

const router = Router();

// === Bot Framework Adapter 設定 ===
const adapterSettings: any = {
  appId: config.teams.appId,
  appPassword: config.teams.appPassword,
};

// Single Tenant Bot 需要設定 channelAuthTenant
if (config.teams.appTenantId) {
  adapterSettings.channelAuthTenant = config.teams.appTenantId;
  console.log(`[TeamsBot] Single Tenant mode, tenant: ${config.teams.appTenantId}`);
}

const adapter = new BotFrameworkAdapter(adapterSettings);

// 全域錯誤處理
adapter.onTurnError = async (context, error) => {
  console.error(`[TeamsBot] Unhandled error: ${error}`);
  console.error(error.stack);

  // 發送錯誤提示給使用者
  await context.sendActivity(
    '⚠️ 抱歉，處理您的訊息時發生錯誤。請稍後再試。',
  );
};

// 建立 Bot 實例
const bot = new KnowledgeAssistantBot();

// === Routes ===

/**
 * POST /api/messages
 * Bot Framework 接收 Teams 訊息的 Webhook endpoint
 * Azure Bot Service 會將 Teams 訊息轉送到這個 endpoint
 */
router.post('/messages', async (req: Request, res: Response) => {
  await adapter.process(req, res, async (context) => {
    await bot.run(context);
  });
});

/**
 * GET /api/bot-health
 * Bot 健康檢查（可用於 Azure App Service health probe）
 */
router.get('/bot-health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    bot: 'KnowledgeAssistantBot',
    teamsEnabled: !!(config.teams.appId && config.teams.appPassword),
    timestamp: new Date().toISOString(),
  });
});

export { adapter };
export default router;
