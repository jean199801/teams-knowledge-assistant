import { Client } from '@notionhq/client';
import { config } from '../config';
import { PageRecord } from './extract';

/**
 * 從 Notion workspace 抓取所有被分享給 Integration 的頁面
 * 轉換成與 KM 相同的 PageRecord 格式
 *
 * 前置條件：
 * 1. Enzo 在 https://www.notion.so/my-integrations 建立 Internal Integration
 * 2. 把需要同步的頁面/資料庫「Share → Invite」給該 Integration
 * 3. 將 Integration Token 設定到 NOTION_API_KEY
 */

let notionClient: Client | null = null;

function getClient(): Client {
  if (notionClient) return notionClient;
  notionClient = new Client({ auth: config.notion.apiKey });
  return notionClient;
}

/**
 * 將 Notion block 轉為 Markdown 文字
 */
function blockToMarkdown(block: any): string {
  const type = block.type;
  if (!type) return '';

  const data = block[type];
  if (!data) return '';

  // 提取 rich_text 內容
  const richText = data.rich_text || data.text || [];
  const text = richText.map((t: any) => {
    let content = t.plain_text || '';
    // 保留粗體、斜體
    if (t.annotations?.bold) content = `**${content}**`;
    if (t.annotations?.italic) content = `*${content}*`;
    if (t.annotations?.code) content = `\`${content}\``;
    return content;
  }).join('');

  switch (type) {
    case 'paragraph':
      return text ? `${text}\n` : '';
    case 'heading_1':
      return `# ${text}\n`;
    case 'heading_2':
      return `## ${text}\n`;
    case 'heading_3':
      return `### ${text}\n`;
    case 'bulleted_list_item':
      return `- ${text}\n`;
    case 'numbered_list_item':
      return `1. ${text}\n`;
    case 'to_do':
      const checked = data.checked ? '☑' : '☐';
      return `${checked} ${text}\n`;
    case 'toggle':
      return `▸ ${text}\n`;
    case 'quote':
      return `> ${text}\n`;
    case 'callout':
      const emoji = data.icon?.emoji || '💡';
      return `${emoji} ${text}\n`;
    case 'code':
      const lang = data.language || '';
      return `\`\`\`${lang}\n${text}\n\`\`\`\n`;
    case 'divider':
      return '---\n';
    case 'table_row':
      const cells = (data.cells || []).map((cell: any) =>
        cell.map((t: any) => t.plain_text || '').join('')
      );
      return `| ${cells.join(' | ')} |\n`;
    case 'bookmark':
    case 'embed':
    case 'link_preview':
      return data.url ? `[${text || data.url}](${data.url})\n` : '';
    case 'image':
      return '[圖片]\n';
    case 'child_page':
      return `📄 ${data.title || ''}\n`;
    case 'child_database':
      return `🗃️ ${data.title || ''}\n`;
    default:
      return text ? `${text}\n` : '';
  }
}

/**
 * 遞迴抓取一個頁面的所有 blocks（含子 blocks）
 */
async function getPageBlocks(notion: Client, blockId: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of response.results) {
      const md = blockToMarkdown(block);
      if (md) lines.push(md);

      // 遞迴抓子 blocks（例如 toggle 內的內容）
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        const childContent = await getPageBlocks(notion, block.id);
        if (childContent) {
          // 子內容縮排
          lines.push(childContent.split('\n').map(l => l ? `  ${l}` : '').join('\n'));
        }
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 取得頁面標題
 */
function getPageTitle(page: any): string {
  const props = page.properties || {};

  // 嘗試各種常見的標題欄位名稱
  for (const key of ['title', 'Title', '名稱', 'Name', '標題']) {
    const prop = props[key];
    if (prop?.title?.length) {
      return prop.title.map((t: any) => t.plain_text || '').join('');
    }
  }

  // fallback: 找第一個 type === 'title' 的欄位
  for (const key of Object.keys(props)) {
    if (props[key]?.type === 'title' && props[key]?.title?.length) {
      return props[key].title.map((t: any) => t.plain_text || '').join('');
    }
  }

  return 'Untitled';
}

/**
 * 取得頁面的分類路徑（用 parent 來判斷）
 */
function getPagePath(page: any, title: string): string {
  // 用 parent 類型來分類
  if (page.parent?.type === 'database_id') {
    return `Notion/${title}`;
  }
  if (page.parent?.type === 'page_id') {
    return `Notion/${title}`;
  }
  return `Notion/${title}`;
}

/**
 * 檢查頁面是否符合狀態篩選條件
 * 如果 statusFilter 為空陣列，則不篩選（全部通過）
 */
function matchesStatusFilter(page: any): boolean {
  const filters = config.notion.statusFilter;
  if (!filters || filters.length === 0) return true;

  const props = page.properties || {};
  // 尋找 type === 'status' 的欄位
  for (const key of Object.keys(props)) {
    if (props[key]?.type === 'status') {
      const statusName = props[key]?.status?.name || '';
      if (filters.includes(statusName)) return true;
    }
  }
  return false;
}

/**
 * 把 Notion page ID 轉為穩定數字 ID（8000000 前綴區隔）
 */
function notionIdToNumber(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return 8000000 + Math.abs(hash % 1000000);
}

/**
 * 從 Notion 抽取所有被分享的頁面
 */
export async function extractNotion(
  lastSyncTime?: Date,
): Promise<PageRecord[]> {
  if (!config.notion.enabled) {
    console.log('[Notion] 未設定 NOTION_API_KEY，略過');
    return [];
  }

  const notion = getClient();
  const statusFilters = config.notion.statusFilter || [];
  console.log('[Notion] 搜尋所有被分享的頁面...');
  if (statusFilters.length > 0) {
    console.log(`[Notion] 狀態篩選: ${statusFilters.join(', ')}`);
  }

  const pages: PageRecord[] = [];
  const seenIds = new Set<string>(); // 避免 search API 分頁重複
  let cursor: string | undefined;
  let totalFound = 0;

  // 用 search API 列出所有被分享給 Integration 的頁面
  do {
    const response: any = await notion.search({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      totalFound++;

      // 去重（search API 分頁可能重複）
      if (seenIds.has(page.id)) continue;
      seenIds.add(page.id);

      const lastEdited = new Date(page.last_edited_time);

      // 如果有 lastSyncTime，只抓更新過的
      if (lastSyncTime && lastEdited <= lastSyncTime) continue;

      // 狀態篩選（只抓符合的頁面）
      if (!matchesStatusFilter(page)) continue;

      const title = getPageTitle(page);
      const pageId = page.id.replace(/-/g, ''); // 去除 dash

      try {
        const content = await getPageBlocks(notion, page.id);
        if (!content || content.length < 10) {
          console.log(`[Notion] 跳過空白頁面: "${title}"`);
          continue;
        }

        pages.push({
          id: notionIdToNumber(page.id),
          path: getPagePath(page, title),
          title,
          description: pageId, // 保留原始 Notion page ID，用於產生連結
          content,
          render: '',
          contentType: 'markdown',
          toc: '',
          updatedAt: lastEdited,
          authorId: 0,
        });

        if (pages.length % 10 === 0) {
          console.log(`[Notion] 已抽取 ${pages.length} 頁...`);
        }
      } catch (err: any) {
        console.warn(`[Notion] 無法讀取 "${title}": ${err.message}`);
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`[Notion] 共找到 ${totalFound} 頁，抽取 ${pages.length} 頁有內容`);
  return pages;
}

/**
 * 抓取單一 Notion 頁面（用於修改後重新同步向量庫）
 * 接受 UUID（含連字號）或 32 字元無連字號格式的 page ID。
 */
export async function fetchSingleNotionPage(pageId: string): Promise<PageRecord | null> {
  if (!config.notion.enabled) return null;

  const notion = getClient();

  try {
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    const title = getPageTitle(page);
    const normalizedId = page.id.replace(/-/g, '');
    const content = await getPageBlocks(notion, page.id);

    if (!content || content.length < 10) {
      console.log(`[Notion] fetchSingleNotionPage: "${title}" 內容為空`);
      return null;
    }

    return {
      id: notionIdToNumber(page.id),
      path: getPagePath(page, title),
      title,
      description: normalizedId,
      content,
      render: '',
      contentType: 'markdown',
      toc: '',
      updatedAt: new Date(page.last_edited_time),
      authorId: 0,
    };
  } catch (err: any) {
    console.error(`[Notion] fetchSingleNotionPage 失敗 (pageId=${pageId}):`, err.message);
    return null;
  }
}
