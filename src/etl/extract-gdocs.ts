import { google } from 'googleapis';
import { config } from '../config';
import { PageRecord } from './extract';
import fs from 'fs';
import mammoth from 'mammoth';

// Google Drive mimeType 常數
const MIME_GOOGLE_DOC = 'application/vnd.google-apps.document';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_FOLDER = 'application/vnd.google-apps.folder';

/**
 * 從 Google Drive 資料夾抓取所有 Google Docs 文件
 * 轉換成與 KM 相同的 PageRecord 格式，讓後續 chunk/embed 流程統一處理
 */

let authClient: any = null;

async function getAuth() {
  if (authClient) return authClient;

  const keyPath = config.googleDocs.serviceAccountKeyPath;
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error(
      `Google Service Account Key 檔案不存在: ${keyPath}\n` +
      '請設定 GOOGLE_SERVICE_ACCOUNT_KEY_PATH 環境變數',
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
    ],
  });

  authClient = await auth.getClient();
  return authClient;
}

interface DriveDoc {
  id: string;
  name: string;
  path: string;
  modifiedTime: string;
  kind: 'gdoc' | 'docx'; // 原生 Google Docs 或上傳的 Word .docx
}

/**
 * 列出資料夾內所有可索引文件（原生 Google Docs + .docx），含子資料夾遞迴
 */
async function listDocsInFolder(
  drive: any,
  folderId: string,
  folderPath: string = 'Google Docs',
): Promise<DriveDoc[]> {
  const docs: DriveDoc[] = [];

  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of res.data.files || []) {
      if (file.mimeType === MIME_GOOGLE_DOC) {
        docs.push({ id: file.id!, name: file.name!, path: `${folderPath}/${file.name}`, modifiedTime: file.modifiedTime!, kind: 'gdoc' });
      } else if (file.mimeType === MIME_DOCX) {
        // 上傳的 Word .docx（同仁直接拖檔進 Drive，沒轉成 Google 文件）
        // 檔名通常含 .docx，path 去掉副檔名讓標題乾淨
        const cleanName = file.name!.replace(/\.docx$/i, '');
        docs.push({ id: file.id!, name: cleanName, path: `${folderPath}/${cleanName}`, modifiedTime: file.modifiedTime!, kind: 'docx' });
      } else if (file.mimeType === MIME_FOLDER) {
        const subDocs = await listDocsInFolder(drive, file.id!, `${folderPath}/${file.name}`);
        docs.push(...subDocs);
      }
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return docs;
}

/**
 * 下載並用 mammoth 解析 .docx 純文字
 */
async function extractDocxContent(drive: any, fileId: string): Promise<string> {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  const buffer = Buffer.from(res.data as ArrayBuffer);
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 從 body.content 提取純文字（共用邏輯）
 */
function extractBodyContent(bodyContent: any[]): string {
  const content: string[] = [];

  for (const element of bodyContent) {
    if (element.paragraph) {
      const paraText = element.paragraph.elements
        ?.map((el: any) => el.textRun?.content || '')
        .join('') || '';

      // 判斷是否為標題
      const style = element.paragraph.paragraphStyle?.namedStyleType;
      if (style === 'HEADING_1') {
        content.push(`# ${paraText.trim()}`);
      } else if (style === 'HEADING_2') {
        content.push(`## ${paraText.trim()}`);
      } else if (style === 'HEADING_3') {
        content.push(`### ${paraText.trim()}`);
      } else {
        content.push(paraText);
      }
    } else if (element.table) {
      // 簡單處理表格：逐列提取文字
      for (const row of element.table.tableRows || []) {
        const cells = (row.tableCells || []).map((cell: any) => {
          return (cell.content || [])
            .map((c: any) =>
              (c.paragraph?.elements || [])
                .map((el: any) => el.textRun?.content?.trim() || '')
                .join(''),
            )
            .join(' ')
            .trim();
        });
        content.push(`| ${cells.join(' | ')} |`);
      }
    }
  }

  return content.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 遞迴收集所有分頁（含子分頁）
 */
function collectTabs(tabs: any[]): Array<{ title: string; bodyContent: any[] }> {
  const result: Array<{ title: string; bodyContent: any[] }> = [];
  for (const tab of tabs) {
    const title = tab.tabProperties?.title || '';
    const bodyContent = tab.documentTab?.body?.content;
    if (bodyContent) {
      result.push({ title, bodyContent });
    }
    // 遞迴子分頁
    if (tab.childTabs?.length) {
      result.push(...collectTabs(tab.childTabs));
    }
  }
  return result;
}

/**
 * 取得 Google Doc 的所有分頁內容
 * 每個分頁回傳獨立的 { tabTitle, content }
 */
async function getDocContentWithTabs(
  docsApi: any,
  docId: string,
): Promise<Array<{ tabTitle: string; content: string }>> {
  // 嘗試用 includeTabsContent 抓取多分頁
  const res = await docsApi.documents.get({
    documentId: docId,
    includeTabsContent: true,
  });
  const doc = res.data;

  // 如果有 tabs 結構（多分頁文件）
  if (doc.tabs?.length) {
    const tabs = collectTabs(doc.tabs);

    // 只有 1 個分頁 → 跟無分頁一樣處理
    if (tabs.length === 1) {
      const content = extractBodyContent(tabs[0].bodyContent);
      return content ? [{ tabTitle: '', content }] : [];
    }

    // 多個分頁 → 每個分頁獨立回傳
    const results: Array<{ tabTitle: string; content: string }> = [];
    for (const tab of tabs) {
      const content = extractBodyContent(tab.bodyContent);
      if (content) {
        results.push({ tabTitle: tab.title, content });
      }
    }
    return results;
  }

  // fallback：舊版 API 沒有 tabs，用 body.content
  const content = extractBodyContent(doc.body?.content || []);
  return content ? [{ tabTitle: '', content }] : [];
}

/**
 * 從 Google Drive 抽取所有 Google Docs，轉為 PageRecord 格式
 */
export async function extractGoogleDocs(
  lastSyncTime?: Date,
): Promise<PageRecord[]> {
  if (!config.googleDocs.enabled) {
    console.log('[Google Docs] 未設定 GOOGLE_DRIVE_FOLDER_ID，略過');
    return [];
  }

  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const docsApi = google.docs({ version: 'v1', auth });

  console.log(`[Google Docs] 掃描資料夾: ${config.googleDocs.folderId}`);

  // 列出所有 Google Docs
  const docList = await listDocsInFolder(drive, config.googleDocs.folderId);
  console.log(`[Google Docs] 找到 ${docList.length} 份文件`);

  // 如果有 lastSyncTime，只抓更新過的
  const filtered = lastSyncTime
    ? docList.filter((d) => new Date(d.modifiedTime) > lastSyncTime)
    : docList;

  console.log(`[Google Docs] 需要同步 ${filtered.length} 份文件`);

  const pages: PageRecord[] = [];

  let docxCount = 0;
  for (let i = 0; i < filtered.length; i++) {
    const doc = filtered[i];
    try {
      if (doc.kind === 'docx') {
        // Word .docx：下載 + mammoth 解析純文字（沒有分頁概念）
        const content = await extractDocxContent(drive, doc.id);
        if (content && content.length >= 10) {
          pages.push({
            id: hashStringToNumber(doc.id),
            path: doc.path,
            title: doc.name,
            description: doc.id,
            content,
            render: '',
            contentType: 'markdown',
            toc: '',
            updatedAt: new Date(doc.modifiedTime),
            authorId: 0,
          });
          docxCount++;
        } else {
          console.log(`[Google Docs] .docx "${doc.name}" 內容過短，略過`);
        }
      } else {
        // 原生 Google Docs：支援多分頁
        const tabContents = await getDocContentWithTabs(docsApi, doc.id);
        for (const tab of tabContents) {
          const title = tab.tabTitle ? `${doc.name} — ${tab.tabTitle}` : doc.name;
          const idSeed = tab.tabTitle ? `${doc.id}_${tab.tabTitle}` : doc.id;
          pages.push({
            id: hashStringToNumber(idSeed),
            path: tab.tabTitle ? `${doc.path}/${tab.tabTitle}` : doc.path,
            title,
            description: doc.id,
            content: tab.content,
            render: '',
            contentType: 'markdown',
            toc: '',
            updatedAt: new Date(doc.modifiedTime),
            authorId: 0,
          });
        }
      }

      if ((i + 1) % 10 === 0) {
        console.log(`[Google Docs] 已抽取 ${i + 1}/${filtered.length} 份`);
      }
    } catch (err: any) {
      console.warn(`[Google Docs] 無法讀取 "${doc.name}" (${doc.kind}): ${err.message}`);
    }
  }

  console.log(`[Google Docs] 抽取完成: ${pages.length} 份（含 ${docxCount} 份 .docx）`);
  return pages;
}

/**
 * 把 Google Doc ID (字串) 轉成穩定的數字 ID，避免跟 KM 的 ID 衝突
 * 加上 9000000 前綴區隔
 */
function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return 9000000 + Math.abs(hash % 1000000);
}
