import { AzureOpenAI } from 'openai';
import { embedBatch } from './embedding';
import { vectorStore, SearchResult } from './vector-store';
import { askClaude } from './claude';
import { config } from '../config';

const llmClient = new AzureOpenAI({
  endpoint: config.azureOpenai.endpoint,
  apiKey: config.azureOpenai.apiKey,
  apiVersion: config.azureOpenai.apiVersion,
});

/**
 * 查詢改寫：用 GPT 把使用者問題展開成多個語意變體，提升召回率。
 * 例：「Line推播設定位置？」→ ["Line推播設定位置？", "LINE 推播怎麼設定", "LINE 推播訊息設定流程"]
 * 失敗時 fallback 回原問題（絕不中斷查詢）。
 */
export async function expandQuery(question: string): Promise<string[]> {
  // 太短或太長都不改寫（成本/效益考量）
  if (question.length < 4 || question.length > 100) return [question];

  try {
    const response = await llmClient.chat.completions.create({
      model: config.chatModel,
      max_tokens: 200,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `你是查詢改寫助手。使用者要查公司知識庫，請把問題改寫成 2 個語意相同但用詞不同的版本，提升搜尋命中率。

規則：
- 保留原始關鍵字（產品名、系統名、專有名詞不要改）
- 換掉模糊的詞（例如「位置」→「怎麼設定」「在哪裡」「流程」）
- 用同義詞、補上常見講法
- 只回傳 JSON 陣列，不要其他文字

範例：
輸入：「Line推播設定位置？」
輸出：["LINE 推播怎麼設定", "LINE 推播訊息設定流程"]`,
        },
        { role: 'user', content: question },
      ],
    });
    const raw = response.choices[0]?.message?.content || '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const variants = JSON.parse(match[0]) as string[];
      const cleaned = variants.filter((v) => typeof v === 'string' && v.trim().length > 0).slice(0, 3);
      // 原問題永遠放第一個，加上變體（去重）
      return [question, ...cleaned.filter((v) => v !== question)];
    }
  } catch (error: any) {
    console.error('[RAG] 查詢改寫失敗，使用原問題:', error.message);
  }
  return [question];
}

export interface RagResponse {
  answer: string;
  sources: Array<{
    title: string;
    path: string;
    category: string;
    score: number;
    sourceType: string;
    sourceId: string;
    description: string;
  }>;
}

/**
 * RAG 查詢流程：
 * 1. 將問題向量化
 * 2. 搜尋最相關的知識片段
 * 3. 組合上下文，呼叫 Claude 生成回答
 */
export async function ragQuery(question: string): Promise<RagResponse> {
  // 0. 如果知識庫是空的，直接回覆（不呼叫外部 API）
  if (vectorStore.stats().total === 0) {
    return {
      answer: '目前知識庫中沒有資料。請先在公司內網執行知識庫同步 (npm run sync)，再重新部署。',
      sources: [],
    };
  }

  // 1. 查詢改寫：展開成多個語意變體，提升召回率
  const queries = await expandQuery(question);
  if (queries.length > 1) {
    console.log(`[RAG] 查詢改寫: ${JSON.stringify(queries)}`);
  }

  // 2. 每個變體各自向量化 + 搜尋，合併取每個 chunk 的最高分
  const queryEmbeddings = await embedBatch(queries);
  const bestByChunk = new Map<string, SearchResult>();
  for (const emb of queryEmbeddings) {
    const hits = vectorStore.search(emb, config.rag.topK);
    for (const hit of hits) {
      const key = hit.entry.id;
      const existing = bestByChunk.get(key);
      if (!existing || hit.score > existing.score) {
        bestByChunk.set(key, hit);
      }
    }
  }

  // 依最高分排序，取 topK
  const results: SearchResult[] = Array.from(bestByChunk.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, config.rag.topK);

  if (results.length === 0) {
    return {
      answer: '目前知識庫中沒有相關資訊。請先執行知識庫同步 (npm run sync)。',
      sources: [],
    };
  }

  // 3. 組合上下文
  const context = results
    .map(
      (r, i) =>
        `[文件 ${i + 1}] ${r.entry.metadata.title} (${r.entry.metadata.path})\n${r.entry.content}`,
    )
    .join('\n\n---\n\n');

  // 4. 呼叫 Claude 生成回答
  const answer = await askClaude(question, context);

  // 5. 整理來源資訊（去重）
  const seenPaths = new Set<string>();
  const sources = results
    .filter((r) => {
      if (seenPaths.has(r.entry.metadata.path)) return false;
      seenPaths.add(r.entry.metadata.path);
      return true;
    })
    .map((r) => ({
      title: r.entry.metadata.title,
      path: r.entry.metadata.path,
      category: r.entry.metadata.category,
      score: Math.round(r.score * 100) / 100,
      sourceType: r.entry.metadata.sourceType,
      sourceId: r.entry.metadata.sourceId,
      description: r.entry.metadata.description,
    }));

  return { answer, sources };
}
