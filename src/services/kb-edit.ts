import { google } from 'googleapis';
import { Client as NotionClient } from '@notionhq/client';
import fs from 'fs';
import { config } from '../config';
import { vectorStore, VectorEntry } from './vector-store';
import { embedBatch } from './embedding';
import { chunkPage, Chunk } from '../etl/chunk';
import { getKmDb } from '../utils/sql-server';
import { PageRecord } from '../etl/extract';
import { appendToWikiPage, replaceInWikiPage, lookupWikiUserId, setPageAuthor } from './wikijs-api';
import { markdownToGoogleDocsRequests, markdownToNotionBlocks } from './publish';
import { fetchSingleNotionPage } from '../etl/extract-notion';

// ── 搜尋包含特定文字的文件 ──

export interface EditCandidate {
  sourceId: string;
  sourceType: 'km_system' | 'google_docs' | 'notion';
  title: string;
  path: string;
  description: string; // Google Doc ID / Notion page ID / KM 頁面 description
  matchSnippet: string; // 匹配上下文
}

/**
 * 給定一組 sourceId，從 vector store 找出對應的 EditCandidate 列表。
 * 用於 parseEditIntent 回傳 targetSourceIds 後，resolve 成完整的文件 metadata。
 */
export function getCandidatesBySourceIds(sourceIds: string[]): EditCandidate[] {
  const wanted = new Set(sourceIds.map(String));
  const entries = vectorStore.getEntries();
  const seen = new Map<string, EditCandidate>();

  for (const entry of entries) {
    const { sourceType, sourceId, title, path, description } = entry.metadata;
    if (!wanted.has(String(sourceId))) continue;
    if (sourceType !== 'google_docs' && sourceType !== 'km_system' && sourceType !== 'notion') continue;
    if (seen.has(sourceId)) continue;

    seen.set(sourceId, {
      sourceId,
      sourceType,
      title,
      path,
      description,
      matchSnippet: '',
    });
  }

  // 保持輸入順序
  const result: EditCandidate[] = [];
  for (const sid of sourceIds) {
    const c = seen.get(String(sid));
    if (c) result.push(c);
  }
  return result;
}

/**
 * 掃描向量庫，找出包含 oldText 的所有文件（去重）
 */
export function searchDocumentsContaining(oldText: string): EditCandidate[] {
  const entries = vectorStore.getEntries();
  const seen = new Map<string, EditCandidate>();

  for (const entry of entries) {
    const { sourceType, sourceId, title, path, description } = entry.metadata;

    // 搜尋 Google Docs、KM 系統、Notion
    if (sourceType !== 'google_docs' && sourceType !== 'km_system' && sourceType !== 'notion') continue;

    // 檢查是否包含目標文字
    if (!entry.content.includes(oldText)) continue;

    // 去重：同一個 sourceId 只列一次
    if (seen.has(sourceId)) continue;

    console.log(`[KBEdit] 找到匹配: sourceType=${sourceType}, sourceId=${sourceId}, title=${title}`);

    // 產生匹配上下文片段
    const idx = entry.content.indexOf(oldText);
    const start = Math.max(0, idx - 30);
    const end = Math.min(entry.content.length, idx + oldText.length + 30);
    const snippet = (start > 0 ? '...' : '') +
      entry.content.slice(start, end) +
      (end < entry.content.length ? '...' : '');

    seen.set(sourceId, {
      sourceId,
      sourceType: sourceType as 'km_system' | 'google_docs' | 'notion',
      title,
      path,
      description,
      matchSnippet: snippet,
    });
  }

  return Array.from(seen.values());
}

// ── 修改 Google Doc ──

export interface EditResult {
  success: boolean;
  error?: string;
}

/**
 * 修改 Google Doc 中的文字（找到並替換）
 */
export async function editGoogleDoc(
  docId: string,
  oldText: string,
  newText: string,
  userEmail?: string,
): Promise<EditResult> {
  if (!config.googleDocs.serviceAccountKeyPath || !fs.existsSync(config.googleDocs.serviceAccountKeyPath)) {
    return { success: false, error: 'Google Service Account Key 未設定' };
  }
  if (!userEmail) {
    return { success: false, error: '無法取得使用者 Google 帳號（userEmail），Google Docs 修改需要 DWD impersonation' };
  }

  try {
    // DWD impersonation
    const saKey = JSON.parse(
      fs.readFileSync(config.googleDocs.serviceAccountKeyPath, 'utf-8'),
    ) as { client_email: string; private_key: string };

    const auth = new google.auth.JWT({
      email: saKey.client_email,
      key: saKey.private_key,
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/documents',
      ],
      subject: userEmail,
    });
    const docs = google.docs({ version: 'v1', auth });

    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          {
            replaceAllText: {
              containsText: { text: oldText, matchCase: true },
              replaceText: newText,
            },
          },
        ],
      },
    });

    console.log(`[KBEdit] Google Doc ${docId} 修改成功 (as ${userEmail}): "${oldText}" → "${newText}"`);
    return { success: true };
  } catch (error: any) {
    console.error(`[KBEdit] Google Doc ${docId} 修改失敗:`, error.message);
    const msg = error.message || '';
    if (msg.includes('unauthorized_client') || msg.includes('invalid_grant')) {
      return { success: false, error: 'Google Workspace DWD 授權問題' };
    }
    if (error.code === 403 || msg.includes('permission')) {
      return { success: false, error: `${userEmail} 沒有權限編輯這份 Google Doc` };
    }
    return { success: false, error: msg };
  }
}

// ── 修改 KM 頁面 ──

/**
 * 修改 KM 系統頁面中的文字（用 Wiki.js GraphQL API）
 */
export async function editKmPage(
  pageId: string,
  oldText: string,
  newText: string,
  authorNameOrEmail?: string,
): Promise<EditResult> {
  const numericId = parseInt(pageId, 10);
  const result = await replaceInWikiPage(numericId, oldText, newText);
  if (result.success) {
    console.log(`[KBEdit] KM page ${pageId} 修改成功: "${oldText}" → "${newText}"`);
    // 修正 authorId
    if (authorNameOrEmail) {
      const authorId = await lookupWikiUserId(authorNameOrEmail);
      if (authorId) {
        await setPageAuthor(numericId, authorId);
      }
    }
  }
  return result;
}

// ── 修改 Notion 頁面 ──

/**
 * 取得 Notion 頁面所有含 rich_text 的 blocks（遞迴含子 blocks）
 */
async function listNotionRichTextBlocks(
  notion: NotionClient,
  blockId: string,
): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;

  do {
    const resp: any = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of resp.results) {
      const data = block[block.type];
      if (data && Array.isArray(data.rich_text)) {
        results.push(block);
      }
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        const children = await listNotionRichTextBlocks(notion, block.id);
        results.push(...children);
      }
    }

    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  return results;
}

/**
 * 把 block 的 rich_text 陣列組成純文字，用於判斷是否命中 oldText
 */
function richTextToPlainText(richText: any[]): string {
  return (richText || []).map((t: any) => t.plain_text || '').join('');
}

/**
 * 產生 Notion 修改紀錄文字（例：🕐 2026-04-17 Jean 修改）
 * Notion 原生沒有 per-block 作者紀錄，所以手動註記，讓讀者知道每次修改的出處
 */
function buildNotionEditAnnotation(userName: string | undefined, action: '修改' | '新增內容'): string {
  const today = new Date().toISOString().slice(0, 10);
  const who = userName && userName.trim() ? userName.trim() : '';
  return who ? `🕐 ${today} ${who} ${action}` : `🕐 ${today} ${action}`;
}

/**
 * 修改 Notion 頁面中的文字（找到並替換）
 * 策略：抓出所有含 rich_text 的 block → 對每個 block 的純文字做 replace →
 * 若有變動，PATCH 該 block，在修改後的文字前另起一行加註「🕐 日期 姓名 修改」
 * （注：會捨棄 block 內的細緻格式，annotation 會以斜體灰色呈現）
 */
export async function editNotionPage(
  pageId: string,
  oldText: string,
  newText: string,
  userName?: string,
): Promise<EditResult> {
  if (!config.notion.apiKey) {
    return { success: false, error: 'Notion API Key 未設定' };
  }

  try {
    const notion = new NotionClient({ auth: config.notion.apiKey });
    const blocks = await listNotionRichTextBlocks(notion, pageId);
    const annotation = buildNotionEditAnnotation(userName, '修改');

    let replacedCount = 0;
    for (const block of blocks) {
      const type = block.type;
      const data = block[type];
      const plainText = richTextToPlainText(data.rich_text);
      if (!plainText.includes(oldText)) continue;

      const updatedText = plainText.split(oldText).join(newText);
      // 預留 annotation + 換行的空間，確保 content 不超過 Notion 2000 字上限
      const annotationFull = `${annotation}\n`;
      const contentLimit = Math.max(0, 2000 - annotationFull.length);
      const newRichText = [
        {
          type: 'text',
          text: { content: annotationFull },
          annotations: { italic: true, color: 'gray' },
        },
        {
          type: 'text',
          text: { content: updatedText.slice(0, contentLimit) },
        },
      ];

      await notion.blocks.update({
        block_id: block.id,
        [type]: { rich_text: newRichText },
      } as any);
      replacedCount++;
    }

    if (replacedCount === 0) {
      return { success: false, error: `在 Notion 頁面中找不到文字「${oldText}」` };
    }

    console.log(`[KBEdit] Notion page ${pageId} 修改成功: "${oldText}" → "${newText}" (${replacedCount} 個 block, by ${userName || 'unknown'})`);
    return { success: true };
  } catch (error: any) {
    console.error(`[KBEdit] Notion page ${pageId} 修改失敗:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 在 Notion 頁面末尾附加內容（markdown → blocks → append children）
 * 會在附加內容前插入一段「🕐 日期 姓名 新增內容」的斜體灰色註記 block
 */
export async function appendToNotionPage(
  pageId: string,
  content: string,
  userName?: string,
): Promise<EditResult> {
  if (!config.notion.apiKey) {
    return { success: false, error: 'Notion API Key 未設定' };
  }

  try {
    const notion = new NotionClient({ auth: config.notion.apiKey });
    const contentBlocks = markdownToNotionBlocks(content);

    if (contentBlocks.length === 0) {
      return { success: false, error: '附加內容為空' };
    }

    const annotationBlock = {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: { content: `${buildNotionEditAnnotation(userName, '新增內容')}：` },
            annotations: { italic: true, color: 'gray' },
          },
        ],
      },
    };

    const blocks = [annotationBlock, ...contentBlocks];

    // Notion API 單次 append 上限 100 個 blocks
    const BATCH_SIZE = 100;
    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
      await notion.blocks.children.append({
        block_id: pageId,
        children: blocks.slice(i, i + BATCH_SIZE),
      });
    }

    console.log(`[KBEdit] Notion page ${pageId} 附加內容成功 (${blocks.length} 個 block, by ${userName || 'unknown'})`);
    return { success: true };
  } catch (error: any) {
    console.error(`[KBEdit] Notion page ${pageId} 附加失敗:`, error.message);
    return { success: false, error: error.message };
  }
}

// ── 重新同步單一文件到向量庫 ──

/**
 * 修改原始文件後，重新抓取 → chunk → embed → 更新向量庫
 */
export async function resyncEditedDocument(
  sourceId: string,
  sourceType: string,
  description: string,
): Promise<void> {
  console.log(`[KBEdit] 重新同步文件: ${sourceType} / ${sourceId}`);

  let pages: PageRecord[] = [];

  if (sourceType === 'google_docs') {
    pages = await refetchGoogleDoc(description); // description = Google Doc ID
  } else if (sourceType === 'km_system') {
    pages = await refetchKmPage(sourceId);
  } else if (sourceType === 'notion') {
    const page = await fetchSingleNotionPage(description); // description = Notion page ID (32-char no dash)
    if (page) pages = [page];
  }

  if (pages.length === 0) {
    console.log(`[KBEdit] 重新抓取失敗，跳過向量庫更新`);
    return;
  }

  // 切片
  const allChunks: Chunk[] = [];
  for (const page of pages) {
    allChunks.push(...chunkPage(page, sourceType as any));
  }

  if (allChunks.length === 0) {
    console.log(`[KBEdit] 切片後無內容`);
    return;
  }

  // 向量化
  const contents = allChunks.map((c) => c.content);
  const embeddings = await embedBatch(contents);

  // 刪除舊片段
  vectorStore.deleteBySource(sourceId);

  // 插入新片段
  for (let i = 0; i < allChunks.length; i++) {
    vectorStore.upsert({
      id: allChunks[i].id,
      content: allChunks[i].content,
      embedding: embeddings[i],
      metadata: allChunks[i].metadata,
    });
  }

  vectorStore.save();
  console.log(`[KBEdit] 向量庫已更新: ${allChunks.length} 個片段`);
}

// ── 重新抓取單一文件 ──

async function refetchGoogleDoc(docId: string): Promise<PageRecord[]> {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.googleDocs.serviceAccountKeyPath,
      scopes: ['https://www.googleapis.com/auth/documents.readonly'],
    });
    const docsApi = google.docs({ version: 'v1', auth });

    const res = await docsApi.documents.get({
      documentId: docId,
      includeTabsContent: true,
    });
    const doc = res.data;
    const title = doc.title || '(無標題)';

    // 簡化版：只取主要內容
    const bodyContent = doc.body?.content || [];
    const content = extractBodyText(bodyContent);

    if (!content) return [];

    return [{
      id: hashStringToNumber(docId),
      path: `Google Docs/${title}`,
      title,
      description: docId,
      content,
      render: '',
      contentType: 'markdown',
      toc: '',
      updatedAt: new Date(),
      authorId: 0,
    }];
  } catch (error: any) {
    console.error(`[KBEdit] 重新抓取 Google Doc ${docId} 失敗:`, error.message);
    return [];
  }
}

async function refetchKmPage(sourceId: string): Promise<PageRecord[]> {
  try {
    const db = await getKmDb();
    const result = await db.request()
      .input('pageId', parseInt(sourceId, 10))
      .query(`
        SELECT id, path, title, description, content, render, contentType, toc, updatedAt, authorId
        FROM [dbo].[pages]
        WHERE id = @pageId
      `);

    return result.recordset.map((row: any) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      description: row.description || '',
      content: row.content || '',
      render: row.render || '',
      contentType: row.contentType || 'markdown',
      toc: row.toc || '',
      updatedAt: row.updatedAt,
      authorId: row.authorId || 0,
    }));
  } catch (error: any) {
    console.error(`[KBEdit] 重新抓取 KM page ${sourceId} 失敗:`, error.message);
    return [];
  }
}

// ── 搜尋指定文件（by 標題關鍵字）──

/**
 * 用文件標題關鍵字搜尋，找到可能的目標文件
 */
export function searchDocumentsByTitle(keyword: string): EditCandidate[] {
  const entries = vectorStore.getEntries();
  const seen = new Map<string, EditCandidate>();
  const kw = keyword.toLowerCase();

  for (const entry of entries) {
    const { sourceType, sourceId, title, path, description } = entry.metadata;
    if (sourceType !== 'google_docs' && sourceType !== 'km_system' && sourceType !== 'notion') continue;
    if (seen.has(sourceId)) continue;

    // 標題匹配
    if (title.toLowerCase().includes(kw)) {
      seen.set(sourceId, {
        sourceId,
        sourceType: sourceType as 'km_system' | 'google_docs' | 'notion',
        title,
        path,
        description,
        matchSnippet: `文件標題：${title}`,
      });
    }
  }

  return Array.from(seen.values());
}

// ── 附加內容到 Google Doc ──

/**
 * 在 Google Doc 末尾附加內容。
 * 透過 Domain-Wide Delegation 以使用者身分寫入（編輯紀錄會標為使用者、不是 SA）。
 * markdown 會被轉成正確的 Google Docs 格式（heading、bullets、code 等）。
 */
export async function appendToGoogleDoc(
  docId: string,
  content: string,
  userEmail?: string,
): Promise<EditResult> {
  if (!config.googleDocs.serviceAccountKeyPath || !fs.existsSync(config.googleDocs.serviceAccountKeyPath)) {
    return { success: false, error: 'Google Service Account Key 未設定' };
  }
  if (!userEmail) {
    return {
      success: false,
      error: '無法取得使用者 Google 帳號（userEmail），Google Docs 修改需要 DWD impersonation',
    };
  }

  try {
    // DWD impersonation：用 SA 假裝成使用者寫入
    const saKey = JSON.parse(
      fs.readFileSync(config.googleDocs.serviceAccountKeyPath, 'utf-8'),
    ) as { client_email: string; private_key: string };

    const auth = new google.auth.JWT({
      email: saKey.client_email,
      key: saKey.private_key,
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/documents',
      ],
      subject: userEmail,
    });
    const docs = google.docs({ version: 'v1', auth });

    // 1. 先取得現有文件末尾位置
    const doc = await docs.documents.get({ documentId: docId });
    const body = doc.data.body;
    const docEndIndex = body?.content?.[body.content.length - 1]?.endIndex || 1;
    // endIndex 是 exclusive，最後一個可插入位置是 docEndIndex - 1
    const insertAt = docEndIndex - 1;

    // 2. 把 markdown 轉成 Google Docs requests（heading/bullet 等有格式）
    const { insertText, styleRequests } = markdownToGoogleDocsRequests(content);

    // 3. 在文件末尾插入 "\n\n" 分隔 + 內容
    // 因為要 append，我們把 insertText 的 location 改成 insertAt（不是 1）
    // 並把 styleRequests 的所有 range 偏移 insertAt + 2（兩個 \n 的 offset）
    const prefix = '\n\n';
    const offsetBase = insertAt + prefix.length;  // 插入分隔符後、真正內容的起始 index

    const requests: any[] = [];
    if (insertText) {
      requests.push({
        insertText: {
          location: { index: insertAt },
          text: prefix + insertText,
        },
      });
      // 把 styleRequests 的 index 偏移（原本是以 index=1 起算）
      for (const req of styleRequests) {
        const shifted = JSON.parse(JSON.stringify(req));
        // shift 任何 range 的 start/end
        const applyShift = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          for (const k of Object.keys(obj)) {
            if (k === 'range' && obj[k]?.startIndex !== undefined) {
              obj[k].startIndex += offsetBase - 1;  // 原本 start=1 → 要 shift 到 offsetBase
              obj[k].endIndex += offsetBase - 1;
            } else if (typeof obj[k] === 'object') {
              applyShift(obj[k]);
            }
          }
        };
        applyShift(shifted);
        requests.push(shifted);
      }
    }

    if (requests.length > 0) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests },
      });
    }

    console.log(`[KBEdit] Google Doc ${docId} 附加內容成功 (as ${userEmail})`);
    return { success: true };
  } catch (error: any) {
    console.error(`[KBEdit] Google Doc ${docId} 附加失敗:`, error.message);
    const msg = error.message || '';
    if (msg.includes('unauthorized_client') || msg.includes('invalid_grant')) {
      return {
        success: false,
        error: 'Google Workspace DWD 授權問題。確認 Admin Console 已設定 domain-wide delegation',
      };
    }
    if (error.code === 403 || msg.includes('permission')) {
      return {
        success: false,
        error: `${userEmail} 沒有權限編輯這份文件（Google Docs API drive.file scope 要求用戶對該文件有編輯權）`,
      };
    }
    return { success: false, error: msg };
  }
}

// ── 附加內容到 KM 頁面 ──

/**
 * 在 KM 頁面內容末尾附加
 */
export async function appendToKmPage(
  pageId: string,
  content: string,
  authorNameOrEmail?: string,
): Promise<EditResult> {
  const numericId = parseInt(pageId, 10);
  const result = await appendToWikiPage(numericId, content);
  if (result.success) {
    console.log(`[KBEdit] KM page ${pageId} 附加內容成功`);
    // 修正 authorId
    if (authorNameOrEmail) {
      const authorId = await lookupWikiUserId(authorNameOrEmail);
      if (authorId) {
        await setPageAuthor(numericId, authorId);
      }
    }
  }
  return result;
}

// ── 工具函式 ──

function extractBodyText(bodyContent: any[]): string {
  const parts: string[] = [];
  for (const element of bodyContent) {
    if (element.paragraph) {
      const text = element.paragraph.elements
        ?.map((el: any) => el.textRun?.content || '')
        .join('') || '';
      const style = element.paragraph.paragraphStyle?.namedStyleType;
      if (style === 'HEADING_1') parts.push(`# ${text.trim()}`);
      else if (style === 'HEADING_2') parts.push(`## ${text.trim()}`);
      else if (style === 'HEADING_3') parts.push(`### ${text.trim()}`);
      else parts.push(text);
    } else if (element.table) {
      for (const row of element.table.tableRows || []) {
        const cells = (row.tableCells || []).map((cell: any) =>
          (cell.content || [])
            .map((c: any) => (c.paragraph?.elements || []).map((el: any) => el.textRun?.content?.trim() || '').join(''))
            .join(' ')
            .trim(),
        );
        parts.push(`| ${cells.join(' | ')} |`);
      }
    }
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return 9000000 + Math.abs(hash % 1000000);
}
