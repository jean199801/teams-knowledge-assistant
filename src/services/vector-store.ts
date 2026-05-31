import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface VectorEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    sourceType: 'km_system' | 'google_docs' | 'notion' | 'local_file' | 'personal_publish';
    sourceId: string;
    title: string;
    description: string;
    path: string;
    category: string;
    chunkIndex: number;
    updatedAt: string;
  };
}

export interface SearchResult {
  entry: VectorEntry;
  score: number;
}

/**
 * 輕量級記憶體向量儲存（MVP 用）
 * 603 篇文件切割後約 2000~3000 個片段，記憶體完全夠用
 * 後續可升級為 Qdrant / Pinecone
 */
class VectorStore {
  private entries: VectorEntry[] = [];
  private loaded = false;

  /**
   * 載入向量資料（從 JSON 檔）
   */
  async load(forceReload = false): Promise<void> {
    if (this.loaded && !forceReload) return;

    if (fs.existsSync(config.vectorStorePath)) {
      const data = fs.readFileSync(config.vectorStorePath, 'utf-8');
      this.entries = JSON.parse(data);
      console.log(`[VectorStore] 已載入 ${this.entries.length} 個知識片段`);
    } else {
      console.log('[VectorStore] 向量檔案不存在，需要先執行同步 (npm run sync)');
    }

    this.loaded = true;
  }

  /**
   * 新增或更新向量
   */
  upsert(entry: VectorEntry): void {
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  /**
   * 刪除特定來源的所有片段（用於重新索引）
   */
  deleteBySource(sourceId: string): void {
    this.entries = this.entries.filter((e) => e.metadata.sourceId !== sourceId);
  }

  /**
   * 搜尋最相關的片段（cosine similarity + 來源優先權重）
   * 優先順序：Notion > Google Docs > KM
   */
  search(queryEmbedding: number[], topK: number = 5): SearchResult[] {
    if (this.entries.length === 0) return [];

    const boosts = config.rag.sourceBoost || {};

    const scored = this.entries.map((entry) => {
      const baseSimilarity = cosineSimilarity(queryEmbedding, entry.embedding);
      const boost = boosts[entry.metadata.sourceType] || 0;
      return {
        entry,
        score: baseSimilarity + boost,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * 持久化到 JSON 檔（串流寫入，避免記憶體爆）
   */
  save(): void {
    const dir = path.dirname(config.vectorStorePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 串流寫入：逐筆序列化，避免一次 JSON.stringify 整個陣列
    const tmpPath = config.vectorStorePath + '.tmp';
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, '[');
    for (let i = 0; i < this.entries.length; i++) {
      if (i > 0) fs.writeSync(fd, ',');
      fs.writeSync(fd, JSON.stringify(this.entries[i]));
    }
    fs.writeSync(fd, ']');
    fs.closeSync(fd);

    // 原子替換
    fs.renameSync(tmpPath, config.vectorStorePath);
    console.log(`[VectorStore] 已儲存 ${this.entries.length} 個知識片段`);
  }

  /**
   * 取得統計資訊
   */
  stats(): { total: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    for (const entry of this.entries) {
      const cat = entry.metadata.category;
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    return { total: this.entries.length, byCategory };
  }

  getEntries(): VectorEntry[] {
    return this.entries;
  }
}

/**
 * Cosine Similarity
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// Singleton
export const vectorStore = new VectorStore();
