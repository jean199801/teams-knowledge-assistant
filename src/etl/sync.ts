import { extractPages } from './extract';
import { extractGoogleDocs } from './extract-gdocs';
import { extractNotion } from './extract-notion';
import { chunkPage, Chunk } from './chunk';
import { embedBatch } from '../services/embedding';
import { vectorStore, VectorEntry } from '../services/vector-store';
import { config } from '../config';

/**
 * 完整同步流程（多來源）：
 * 1. 從 KM DB 抽取文件
 * 2. 從 Google Docs 抽取文件（如有設定）
 * 3. 切割成片段
 * 4. 批次向量化
 * 5. 存入 Vector Store
 */
export async function syncKnowledgeBase(
  lastSyncTime?: Date,
): Promise<{ pagesProcessed: number; chunksCreated: number }> {
  console.log('\n========================================');
  console.log('  知識庫同步開始（多來源）');
  console.log('========================================\n');

  const allChunks: Chunk[] = [];
  let totalPages = 0;

  // ── Source 1: KM 系統 ──
  console.log('── [KM 系統] ──');
  const kmPages = await extractPages(lastSyncTime);
  if (kmPages.length > 0) {
    console.log(`[Chunk] 切割 ${kmPages.length} 篇 KM 文件...`);
    for (const page of kmPages) {
      allChunks.push(...chunkPage(page, 'km_system'));
    }
    totalPages += kmPages.length;
  } else {
    console.log('[KM] 沒有新文件');
  }

  // ── Source 2: Google Docs ──
  if (config.googleDocs.enabled) {
    console.log('\n── [Google Docs] ──');
    try {
      const gdocPages = await extractGoogleDocs(lastSyncTime);
      if (gdocPages.length > 0) {
        console.log(`[Chunk] 切割 ${gdocPages.length} 份 Google Docs...`);
        for (const page of gdocPages) {
          allChunks.push(...chunkPage(page, 'google_docs'));
        }
        totalPages += gdocPages.length;
      } else {
        console.log('[Google Docs] 沒有新文件');
      }
    } catch (err: any) {
      console.error(`[Google Docs] 同步失敗: ${err.message}`);
    }
  }

  // ── Source 3: Notion ──
  if (config.notion.enabled) {
    console.log('\n── [Notion] ──');
    try {
      const notionPages = await extractNotion(lastSyncTime);
      if (notionPages.length > 0) {
        console.log(`[Chunk] 切割 ${notionPages.length} 頁 Notion...`);
        for (const page of notionPages) {
          allChunks.push(...chunkPage(page, 'notion'));
        }
        totalPages += notionPages.length;
      } else {
        console.log('[Notion] 沒有新文件');
      }
    } catch (err: any) {
      console.error(`[Notion] 同步失敗: ${err.message}`);
    }
  }

  // ── 結果彙整 ──
  if (allChunks.length === 0) {
    console.log('\n[Sync] 沒有新的或更新的文件需要同步');
    return { pagesProcessed: 0, chunksCreated: 0 };
  }

  console.log(`\n[Chunk] 共產生 ${allChunks.length} 個知識片段`);

  // 批次向量化
  console.log(`[Embed] 開始向量化 ${allChunks.length} 個片段...`);
  const contents = allChunks.map((c) => c.content);
  const embeddings = await embedBatch(contents);
  console.log(`[Embed] 向量化完成`);

  // 存入 Vector Store
  await vectorStore.load();

  // ⚠️ 重要：只刪除「這次有重新抓到並打算重新寫入的文件」對應的舊片段。
  //
  // 之前的 bug：原本的 code 會把所有 google_docs / notion 類型的 entries 全清空，
  // 不管這次 sync 有沒有重新抓到那些來源的文件。結果：
  //   - 每次增量 sync（只有 1 篇 KM 更新）→ 把 435 個 gdocs + 836 個 notion 全刪 → 永久丟失
  // 修法：從 allChunks（這次新產生的片段）抽出 sourceId，只刪這些對應的舊版 chunks。
  // 其他來源（沒被更新的 gdocs / notion）舊 entries 完全不動。
  const sourceIdsToReplace = new Set<string>(allChunks.map((c) => c.metadata.sourceId));
  for (const id of sourceIdsToReplace) {
    vectorStore.deleteBySource(id);
  }

  // 插入新片段
  for (let i = 0; i < allChunks.length; i++) {
    const entry: VectorEntry = {
      id: allChunks[i].id,
      content: allChunks[i].content,
      embedding: embeddings[i],
      metadata: allChunks[i].metadata,
    };
    vectorStore.upsert(entry);
  }

  // 持久化
  vectorStore.save();

  // 輸出統計
  const stats = vectorStore.stats();
  console.log('\n========================================');
  console.log('  同步完成！');
  console.log(`  處理文件: ${totalPages} 篇`);
  console.log(`  新增片段: ${allChunks.length} 個`);
  console.log(`  知識庫總量: ${stats.total} 個片段`);
  console.log('  各來源/分類統計:');
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    console.log(`    - ${cat}: ${count} 個片段`);
  }
  console.log('========================================\n');

  return { pagesProcessed: totalPages, chunksCreated: allChunks.length };
}
