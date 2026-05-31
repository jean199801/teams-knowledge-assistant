import { Client } from '@notionhq/client';
import { google } from 'googleapis';
import fs from 'fs';
import { config } from '../config';
import { vectorStore, VectorEntry } from './vector-store';
import { embedBatch } from './embedding';
import { getKmDb } from '../utils/sql-server';
import { createWikiPage, lookupWikiUserId, setPageAuthor } from './wikijs-api';
import { BlobImage } from './personal-store';
import { downloadImage as blobDownloadImage, generateSasUrl as blobGenerateSasUrl, deleteImages as blobDeleteImages } from './blob-storage';

export interface PublishResult {
  success: boolean;
  url: string;
  error?: string;
}

// ── Notion ──

/**
 * 列出 Notion 可用的頁面（用於位置建議）
 */
export async function listNotionPages(): Promise<Array<{ id: string; name: string }>> {
  if (!config.notion.apiKey) return [];
  const notion = new Client({ auth: config.notion.apiKey });

  try {
    const response = await notion.search({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 20,
    });

    return response.results.map((page: any) => {
      const titleProp = page.properties?.title || page.properties?.Name;
      let name = '(無標題)';
      if (titleProp?.title?.[0]?.plain_text) {
        name = titleProp.title[0].plain_text;
      } else if (page.properties) {
        // 嘗試從其他屬性取得標題
        for (const prop of Object.values(page.properties) as any[]) {
          if (prop.type === 'title' && prop.title?.[0]?.plain_text) {
            name = prop.title[0].plain_text;
            break;
          }
        }
      }
      return { id: page.id, name };
    });
  } catch (error: any) {
    console.error('[Publish] 列出 Notion 頁面失敗:', error.message);
    return [];
  }
}

/**
 * 發布到 Notion
 */
export async function publishToNotion(
  title: string,
  content: string,
  parentPageId?: string,
): Promise<PublishResult> {
  if (!config.notion.apiKey) {
    return { success: false, url: '', error: 'Notion API Key 未設定' };
  }

  const notion = new Client({ auth: config.notion.apiKey });
  const parentId = parentPageId || config.personalAssistant.notionPublishParentPageId;

  if (!parentId) {
    return { success: false, url: '', error: '未設定 Notion 發布位置 (NOTION_PUBLISH_PARENT_PAGE_ID)' };
  }

  try {
    // 把 markdown 轉成對應的 Notion block 陣列（heading / bullet / code / paragraph）
    const blocks = markdownToNotionBlocks(content);

    const page = await notion.pages.create({
      parent: { page_id: parentId },
      properties: {
        title: {
          title: [{ text: { content: title } }],
        },
      },
      children: blocks,
    });

    const pageId = page.id.replace(/-/g, '');
    const url = `https://www.notion.so/${pageId}`;

    return { success: true, url };
  } catch (error: any) {
    console.error('[Publish] 發布到 Notion 失敗:', error.message);
    return { success: false, url: '', error: error.message };
  }
}

// Notion API 單一 rich_text 最多 2000 字
const NOTION_TEXT_LIMIT = 2000;

function notionRichText(text: string): any[] {
  return [
    {
      type: 'text',
      text: { content: (text || '').slice(0, NOTION_TEXT_LIMIT) },
    },
  ];
}

/**
 * 把 markdown 字串轉成 Notion block 陣列
 * 支援：
 *   - # / ## / ### → heading_1 / heading_2 / heading_3
 *   - - item / * item → bulleted_list_item
 *   - 1. item / 2. item → numbered_list_item
 *   - ```lang ... ``` → code block
 *   - 其他連續文字 → paragraph（用空行分段）
 * 不處理 inline 標記（**bold**、*italic*、`code`）— 保留字面文字
 */
export function markdownToNotionBlocks(content: string): any[] {
  const blocks: any[] = [];
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');

  let i = 0;
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join('\n').trim();
    paragraphBuffer = [];
    if (!text) return;
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: notionRichText(text) },
    });
  };

  while (i < lines.length) {
    const line = lines[i];

    // 空行 → 段落分隔
    if (line.trim() === '') {
      flushParagraph();
      i++;
      continue;
    }

    // Fenced code block
    const codeFenceMatch = line.match(/^```(\w*)\s*$/);
    if (codeFenceMatch) {
      flushParagraph();
      const lang = codeFenceMatch[1] || 'plain text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // 跳過結尾 ```
      blocks.push({
        object: 'block',
        type: 'code',
        code: {
          rich_text: notionRichText(codeLines.join('\n')),
          language: mapNotionCodeLanguage(lang),
        },
      });
      continue;
    }

    // Heading 1-3
    const headingMatch = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const type = level === 1 ? 'heading_1' : level === 2 ? 'heading_2' : 'heading_3';
      blocks.push({
        object: 'block',
        type,
        [type]: { rich_text: notionRichText(text) },
      });
      i++;
      continue;
    }

    // Bulleted list item (- 或 *)
    const bulletMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: notionRichText(bulletMatch[1]) },
      });
      i++;
      continue;
    }

    // Numbered list item (1. 2. 3.)
    const numberedMatch = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (numberedMatch) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: notionRichText(numberedMatch[1]) },
      });
      i++;
      continue;
    }

    // 其他 → 累積成 paragraph
    paragraphBuffer.push(line);
    i++;
  }

  flushParagraph();
  return blocks;
}

/**
 * 把 markdown code fence 的語言標籤轉成 Notion API 允許的 language 字串
 * Notion 只接受特定語言列表，未知的語言 fallback 為 'plain text'
 */
function mapNotionCodeLanguage(lang: string): string {
  const normalized = (lang || '').toLowerCase().trim();
  const allowed = new Set([
    'bash', 'c', 'c#', 'c++', 'clojure', 'coffeescript', 'css', 'dart',
    'diff', 'docker', 'elixir', 'elm', 'erlang', 'go', 'graphql', 'groovy',
    'haskell', 'html', 'java', 'javascript', 'json', 'kotlin', 'latex',
    'less', 'lisp', 'lua', 'makefile', 'markdown', 'matlab', 'nix',
    'objective-c', 'ocaml', 'pascal', 'perl', 'php', 'plain text',
    'powershell', 'python', 'r', 'ruby', 'rust', 'sass', 'scala', 'scheme',
    'scss', 'shell', 'sql', 'swift', 'typescript', 'vb.net', 'verilog',
    'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml',
  ]);
  const aliases: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    sh: 'shell',
    zsh: 'shell',
    yml: 'yaml',
    cs: 'c#',
    cpp: 'c++',
  };
  const mapped = aliases[normalized] || normalized;
  return allowed.has(mapped) ? mapped : 'plain text';
}

// ── KM 系統 ──

/**
 * 列出 KM 系統的分類
 */
export async function listKmCategories(): Promise<Array<{ id: string; name: string }>> {
  try {
    const db = await getKmDb();
    const result = await db.request().query(`
      SELECT DISTINCT
        CASE
          WHEN CHARINDEX('/', p.path) > 0 THEN LEFT(p.path, CHARINDEX('/', p.path) - 1)
          ELSE p.path
        END AS category
      FROM [dbo].[pages] p
      WHERE p.isPublished = 1 AND p.isPrivate = 0
      ORDER BY category
    `);

    return result.recordset.map((row: any) => ({
      id: row.category,
      name: row.category,
    }));
  } catch (error: any) {
    console.error('[Publish] 列出 KM 分類失敗:', error.message);
    return [];
  }
}

/**
 * 把一組 Blob 圖片轉成 base64 data URI，嵌入 KM markdown 中
 * Wiki.js 原生支援 `![](data:image/...;base64,...)`，不需要透過 /u upload endpoint
 * 優：不依賴 Wiki.js API token 權限、不依賴任何外部 URL、隱私完全在 KM 內
 * 缺：頁面 markdown 會變大（base64 是原圖的 1.3x）— 但 30 人內用、每人每月幾張圖，可接受
 */
async function imagesToKmDataUris(images: BlobImage[]): Promise<{
  dataUris: string[];
  failures: string[];
}> {
  const dataUris: string[] = [];
  const failures: string[] = [];
  for (const img of images) {
    try {
      const buf = await blobDownloadImage(img.blobName);
      const base64 = buf.toString('base64');
      dataUris.push(`data:${img.contentType};base64,${base64}`);
    } catch (err: any) {
      failures.push(err.message || String(err));
    }
  }
  return { dataUris, failures };
}

/**
 * 發布到 KM 系統
 */
export async function publishToKm(
  title: string,
  content: string,
  category?: string,
  authorNameOrEmail?: string,
  images: BlobImage[] = [],
): Promise<PublishResult> {
  try {
    // 把圖片轉成 base64 data URI 嵌入 markdown（不依賴 Wiki.js asset upload API）
    let finalContent = content;
    if (images.length > 0) {
      const { dataUris, failures } = await imagesToKmDataUris(images);
      if (dataUris.length > 0) {
        finalContent = finalContent.trimEnd() + '\n\n' + dataUris.map((u, i) => `![附圖 ${i + 1}](${u})`).join('\n\n');
        console.log(`[Publish] KM 嵌入 ${dataUris.length} 張 base64 圖片`);
      }
      if (failures.length > 0) {
        console.warn(`[Publish] KM 讀取 Blob 失敗 (${failures.length}/${images.length}):`, failures.join('; '));
      }
    }

    // 用標題產生 URL-safe 的 path slug
    const slug = title
      .replace(/[^\w\u4e00-\u9fff-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    const path = `${category || 'personal'}/${slug}-${Date.now()}`;

    const result = await createWikiPage(
      title,
      finalContent,
      path,
      `個人筆記發布 - ${new Date().toISOString().slice(0, 10)}`,
    );

    if (!result.success) {
      return { success: false, url: '', error: result.error };
    }

    console.log(`[Publish] KM 新頁面建立成功，id=${result.pageId}, path=${result.path}`);

    // 修正 authorId（Wiki.js API Token 不綁使用者，預設會是 admin）
    if (result.pageId && authorNameOrEmail) {
      const authorId = await lookupWikiUserId(authorNameOrEmail);
      if (authorId) {
        await setPageAuthor(result.pageId, authorId);
      } else {
        console.log(`[Publish] 找不到 Wiki.js 使用者對應: ${authorNameOrEmail}`);
      }
    }

    const url = `${config.kmBaseUrl}/${result.path}`;
    return { success: true, url };
  } catch (error: any) {
    console.error('[Publish] 發布到 KM 失敗:', error.message);
    return { success: false, url: '', error: error.message };
  }
}

// ── Google Docs ──

/**
 * 列出 Google Drive 資料夾
 */
export async function listGoogleDocsFolders(): Promise<Array<{ id: string; name: string }>> {
  if (!config.googleDocs.serviceAccountKeyPath || !fs.existsSync(config.googleDocs.serviceAccountKeyPath)) {
    return [];
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.googleDocs.serviceAccountKeyPath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name)',
      pageSize: 20,
      orderBy: 'modifiedTime desc',
    });

    return (res.data.files || []).map((f) => ({
      id: f.id!,
      name: f.name!,
    }));
  } catch (error: any) {
    console.error('[Publish] 列出 Google Docs 資料夾失敗:', error.message);
    return [];
  }
}

/**
 * 把 markdown 內容轉成 Google Docs batchUpdate request 序列
 * 支援：
 *   - # / ## / ### → HEADING_1 / HEADING_2 / HEADING_3 paragraph style
 *   - - item / * item → 有序符號列表
 *   - 1. item → 編號列表
 *   - ```code``` → 用 Consolas 等寬字體
 *   - 其他文字 → 普通段落
 * 不處理 inline markdown (**bold** / *italic* / `code`)，保留字面文字。
 *
 * Google Docs index 是 1-based；endIndex 為 exclusive（半開區間）。
 * updateParagraphStyle 會自動對齊到完整段落，範圍不需要精準。
 */
export function markdownToGoogleDocsRequests(markdown: string): {
  insertText: string;
  styleRequests: any[];
} {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  let insertText = '';
  let cursor = 1;
  const styleRequests: any[] = [];
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine;

    // Fenced code block 開關（不把 ``` 本身寫入 doc）
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Code block 內容 → 等寬字體
    if (inCodeBlock) {
      const text = line + '\n';
      const start = cursor;
      insertText += text;
      cursor += text.length;
      styleRequests.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: cursor - 1 },
          textStyle: {
            weightedFontFamily: { fontFamily: 'Consolas' },
          },
          fields: 'weightedFontFamily',
        },
      });
      continue;
    }

    // Heading 1-3
    const headingMatch = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2] + '\n';
      const start = cursor;
      insertText += text;
      cursor += text.length;
      styleRequests.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: cursor },
          paragraphStyle: { namedStyleType: `HEADING_${level}` },
          fields: 'namedStyleType',
        },
      });
      continue;
    }

    // Bullet list
    const bulletMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bulletMatch) {
      const text = bulletMatch[1] + '\n';
      const start = cursor;
      insertText += text;
      cursor += text.length;
      styleRequests.push({
        createParagraphBullets: {
          range: { startIndex: start, endIndex: cursor - 1 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
      continue;
    }

    // Numbered list
    const numberedMatch = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (numberedMatch) {
      const text = numberedMatch[1] + '\n';
      const start = cursor;
      insertText += text;
      cursor += text.length;
      styleRequests.push({
        createParagraphBullets: {
          range: { startIndex: start, endIndex: cursor - 1 },
          bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
        },
      });
      continue;
    }

    // 普通段落（含空行）
    const text = line + '\n';
    insertText += text;
    cursor += text.length;
  }

  return { insertText, styleRequests };
}

/**
 * 發布到 Google Docs
 *
 * 透過 Domain-Wide Delegation 用 Service Account 假裝成使用者（subject: userEmail），
 * 這樣：
 *   - 建立的檔案 owner 是使用者本人
 *   - 檔案落在使用者自己的「我的雲端硬碟」（或指定的共用資料夾）
 *   - 不占用 Service Account 的儲存配額
 *
 * 需要 Google Workspace admin 先在 Admin Console → API controls → Domain-wide delegation
 * 把這個 SA 的 Client ID 加入、授權 drive.file + documents 兩個 scope。
 */
export async function publishToGoogleDocs(
  title: string,
  content: string,
  folderId?: string,
  userEmail?: string,
  images: BlobImage[] = [],
): Promise<PublishResult> {
  if (!config.googleDocs.serviceAccountKeyPath || !fs.existsSync(config.googleDocs.serviceAccountKeyPath)) {
    return { success: false, url: '', error: 'Google Service Account Key 未設定' };
  }

  if (!userEmail) {
    return {
      success: false,
      url: '',
      error: '無法取得使用者 Google 帳號（userEmail），請確認 Teams 用戶有 AAD email',
    };
  }

  try {
    // DWD impersonation：用 SA 假裝成使用者建立文件
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
      subject: userEmail,  // ⭐ 關鍵：impersonate 此使用者
    });

    const drive = google.drive({ version: 'v3', auth });
    const docs = google.docs({ version: 'v1', auth });

    // 1. 建立 Google Doc
    // - 有指定 folderId → 建在該資料夾（支援 Shared Drive）
    // - 沒指定 → 建在使用者自己的「我的雲端硬碟」root
    const fileRes = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: 'application/vnd.google-apps.document',
        ...(folderId ? { parents: [folderId] } : {}),
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true,
    });
    const docId = fileRes.data.id!;

    // 2. 把 markdown 轉成 Google Docs 結構化 requests
    const { insertText, styleRequests } = markdownToGoogleDocsRequests(content);

    const requests: any[] = [];
    if (insertText) {
      requests.push({
        insertText: {
          location: { index: 1 },
          text: insertText,
        },
      });
      // style 要在 insertText 之後（必須先有文字才能 apply style）
      requests.push(...styleRequests);
    }

    if (requests.length > 0) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests },
      });
    }

    // 3. 處理圖片：每張圖產生短期 SAS URL → Docs insertInlineImage 抓取後存內部副本
    //    之後 SAS 過期也沒差（Docs 已有自己的圖檔）
    if (images.length > 0) {
      try {
        // 取目前文件末尾位置作為圖片插入起點
        const doc = await docs.documents.get({ documentId: docId });
        const body = doc.data.body;
        const docEndIndex = body?.content?.[body.content.length - 1]?.endIndex || 1;
        let cursor = Math.max(1, docEndIndex - 1);

        const imageRequests: any[] = [];
        for (const img of images) {
          try {
            // 5 分鐘有效的 SAS URL 足夠 Google Docs 伺服器抓取一次
            const sasUrl = blobGenerateSasUrl(img.blobName, 5);
            imageRequests.push({
              insertText: { location: { index: cursor }, text: '\n' },
            });
            cursor += 1;
            imageRequests.push({
              insertInlineImage: { location: { index: cursor }, uri: sasUrl },
            });
            cursor += 1; // inline image 算 1 個字元
          } catch (err: any) {
            console.error(`[Publish] Google Docs 準備圖片 ${img.blobName} 失敗:`, err.message);
          }
        }

        if (imageRequests.length > 0) {
          await docs.documents.batchUpdate({
            documentId: docId,
            requestBody: { requests: imageRequests },
          });
          console.log(`[Publish] Google Doc ${docId} 插入 ${imageRequests.length / 2} 張圖片`);
        }
      } catch (imgErr: any) {
        console.error('[Publish] Google Docs 插入圖片階段失敗（文字已成功）:', imgErr.message);
        // 文字已成功，圖片失敗不中斷發布
      }
    }

    const url = fileRes.data.webViewLink || `https://docs.google.com/document/d/${docId}/edit`;
    console.log(`[Publish] Google Doc 建立成功 (as ${userEmail}): ${docId}`);
    return { success: true, url };
  } catch (error: any) {
    console.error('[Publish] 發布到 Google Docs 失敗:', error.message);

    // DWD 相關錯誤給更清楚的提示
    const msg = error.message || '';
    if (msg.includes('unauthorized_client') || msg.includes('invalid_grant')) {
      return {
        success: false,
        url: '',
        error: `Google Workspace 未正確授權。可能原因：(1) Admin 還沒在 Google Admin Console → API controls → Domain-wide delegation 設定這個 Service Account（Client ID: 106163490276834434384），或 (2) 設定剛完成還在傳播（等 5-10 分鐘）。`,
      };
    }
    if (msg.includes('Not a valid email') || msg.includes('invalid_subject')) {
      return {
        success: false,
        url: '',
        error: `找不到 Google Workspace 使用者 ${userEmail}。請確認 Teams 帳號對應的 email 在公司 Google Workspace 有對應的使用者。`,
      };
    }
    if (error.code === 403 || msg.includes('permission')) {
      return {
        success: false,
        url: '',
        error: `Google API 權限不足。確認 DWD scope 包含 drive.file 和 documents。`,
      };
    }
    return { success: false, url: '', error: msg };
  }
}

// ── 同步寫入向量庫 ──

/**
 * 將發布的筆記寫入向量庫，讓知識助手能搜到
 */
export async function publishToVectorStore(
  title: string,
  content: string,
  author: string,
  noteId: number,
): Promise<void> {
  const sourceId = `personal_${author}_${noteId}`;

  // 先刪除舊版本（如果重複發布）
  vectorStore.deleteBySource(sourceId);

  // 組合完整內容
  const fullContent = `# [個人筆記] ${title}\n\n${content}`;

  // 向量化
  const embeddings = await embedBatch([fullContent]);

  // 寫入向量庫
  const entry: VectorEntry = {
    id: `personal_${sourceId}_0`,
    content: fullContent,
    embedding: embeddings[0],
    metadata: {
      sourceType: 'personal_publish',
      sourceId,
      title,
      description: `${author} 的個人筆記`,
      path: `personal/${author}`,
      category: 'personal',
      chunkIndex: 0,
      updatedAt: new Date().toISOString(),
    },
  };

  vectorStore.upsert(entry);
  vectorStore.save();

  console.log(`[Publish] 已寫入向量庫: ${title} (by ${author})`);
}

// ── 統一發布入口 ──

/**
 * 發布筆記到指定平台 + 同步寫入向量庫
 *
 * @param author 顯示名稱或 email，用於 KM 的 authorId 對應
 * @param userEmail 使用者 Google Workspace email，Google Docs DWD 必要（沒給 gdocs 會失敗）
 */
export async function publishNote(
  platform: string,
  title: string,
  content: string,
  author: string,
  noteId: number,
  locationId?: string,
  userEmail?: string,
  images: BlobImage[] = [],
): Promise<PublishResult> {
  let result: PublishResult;

  switch (platform) {
    case 'notion':
      // Notion 不支援個人筆記建立新頁面（publishToNotion 保留但不從 publishNote 走）
      result = await publishToNotion(title, content, locationId);
      break;
    case 'km':
      result = await publishToKm(title, content, locationId, author, images);
      break;
    case 'gdocs':
      result = await publishToGoogleDocs(title, content, locationId, userEmail, images);
      break;
    default:
      return { success: false, url: '', error: `不支援的平台: ${platform}` };
  }

  if (result.success) {
    // 發布成功後背景寫入向量庫（不阻塞）
    publishToVectorStore(title, content, author, noteId).catch((error) => {
      console.error('[Publish] 背景向量庫同步失敗:', error.message);
    });

    // 發布成功 → 目標平台已有自己的圖檔副本 → 清除 Blob 原圖
    if (images.length > 0) {
      blobDeleteImages(images.map((i) => i.blobName)).catch((error) => {
        console.error('[Publish] 清除 Blob 圖片失敗（不影響發布結果）:', error.message);
      });
    }
  }

  return result;
}
