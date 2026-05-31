import { Router, Request, Response } from 'express';
import { ragQuery } from '../services/rag';
import { vectorStore } from '../services/vector-store';

const router = Router();

/**
 * POST /api/chat
 * Body: { question: string }
 * Response: { answer: string, sources: [...] }
 */
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { question } = req.body;

    if (!question || typeof question !== 'string') {
      res.status(400).json({ error: '請提供 question 欄位' });
      return;
    }

    console.log(`[Chat] 收到問題: ${question}`);

    const result = await ragQuery(question);

    console.log(`[Chat] 回答完成，參考 ${result.sources.length} 個來源`);

    res.json({
      answer: result.answer,
      sources: result.sources,
    });
  } catch (error: any) {
    console.error('[Chat] 錯誤:', error.message);
    res.status(500).json({ error: '處理問題時發生錯誤，請稍後再試' });
  }
});

/**
 * GET /api/stats
 * 知識庫統計資訊
 */
router.get('/stats', (_req: Request, res: Response) => {
  const stats = vectorStore.stats();
  res.json(stats);
});

/**
 * GET /api/health
 */
router.get('/health', (_req: Request, res: Response) => {
  const stats = vectorStore.stats();
  res.json({
    status: 'ok',
    knowledgeBase: {
      totalChunks: stats.total,
      categories: stats.byCategory,
    },
  });
});

export default router;
