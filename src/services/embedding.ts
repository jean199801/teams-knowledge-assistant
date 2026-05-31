import { AzureOpenAI } from 'openai';
import { config } from '../config';

const client = new AzureOpenAI({
  endpoint: config.azureOpenai.endpoint,
  apiKey: config.azureOpenai.apiKey,
  apiVersion: config.azureOpenai.apiVersion,
});

/**
 * 將文字轉為向量（使用 Azure OpenAI text-embedding-3-small）
 */
export async function embed(text: string): Promise<number[]> {
  const response = await client.embeddings.create({
    model: config.embeddingModel,
    input: text,
  });
  return response.data[0].embedding;
}

/**
 * 批次向量化（每次最多 100 筆，含 rate limit 重試）
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const batchSize = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(texts.length / batchSize);
    console.log(`[Embed] 處理第 ${batchNum}/${totalBatches} 批...`);

    let retries = 0;
    while (true) {
      try {
        const response = await client.embeddings.create({
          model: config.embeddingModel,
          input: batch,
        });
        allEmbeddings.push(...response.data.map((d) => d.embedding));
        break;
      } catch (err: any) {
        if (err?.status === 429 && retries < 5) {
          retries++;
          const waitMs = retries * 2000;
          console.log(`[Embed] Rate limited, 等待 ${waitMs}ms 後重試 (${retries}/5)...`);
          await new Promise((r) => setTimeout(r, waitMs));
        } else {
          throw err;
        }
      }
    }

    if (i + batchSize < texts.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return allEmbeddings;
}
