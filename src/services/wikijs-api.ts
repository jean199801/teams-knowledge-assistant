import { config } from '../config';
import { getKmDb } from '../utils/sql-server';

/**
 * Wiki.js GraphQL API 包裝
 * 透過正式 API 建立/更新頁面，會自動處理 pageTree、render、authorId 等
 */

interface GraphQLRequest {
  query: string;
  variables?: Record<string, any>;
}

async function graphqlRequest<T = any>(req: GraphQLRequest): Promise<T> {
  if (!config.wikijs.apiToken) {
    throw new Error('WIKIJS_API_TOKEN 未設定');
  }

  const response = await fetch(config.wikijs.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.wikijs.apiToken}`,
    },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    throw new Error(`Wiki.js API HTTP ${response.status}: ${await response.text()}`);
  }

  const result: any = await response.json();
  if (result.errors) {
    throw new Error(`Wiki.js API 錯誤: ${JSON.stringify(result.errors)}`);
  }

  return result.data as T;
}

// ── 建立新頁面 ──

export interface CreatePageResult {
  success: boolean;
  pageId?: number;
  path?: string;
  error?: string;
}

/**
 * 建立新 Wiki.js 頁面
 */
export async function createWikiPage(
  title: string,
  content: string,
  path: string,
  description = '',
): Promise<CreatePageResult> {
  const mutation = `
    mutation CreatePage(
      $content: String!,
      $description: String!,
      $editor: String!,
      $isPublished: Boolean!,
      $isPrivate: Boolean!,
      $locale: String!,
      $path: String!,
      $tags: [String]!,
      $title: String!
    ) {
      pages {
        create(
          content: $content,
          description: $description,
          editor: $editor,
          isPrivate: $isPrivate,
          isPublished: $isPublished,
          locale: $locale,
          path: $path,
          tags: $tags,
          title: $title
        ) {
          responseResult {
            succeeded
            errorCode
            slug
            message
          }
          page {
            id
            path
            title
          }
        }
      }
    }
  `;

  try {
    const data = await graphqlRequest({
      query: mutation,
      variables: {
        content,
        description,
        editor: 'markdown',
        isPublished: true,
        isPrivate: false,
        locale: 'zh-tw',
        path,
        tags: [],
        title,
      },
    });

    const result = data.pages.create;
    if (!result.responseResult.succeeded) {
      return {
        success: false,
        error: result.responseResult.message || result.responseResult.slug,
      };
    }

    return {
      success: true,
      pageId: result.page.id,
      path: result.page.path,
    };
  } catch (error: any) {
    console.error('[WikiJS] createWikiPage 失敗:', error.message);
    return { success: false, error: error.message };
  }
}

// ── 取得單一頁面 ──

export async function getWikiPage(pageId: number): Promise<{
  id: number;
  title: string;
  content: string;
  path: string;
  description: string;
} | null> {
  const query = `
    query GetPage($id: Int!) {
      pages {
        single(id: $id) {
          id
          title
          content
          path
          description
        }
      }
    }
  `;

  try {
    const data = await graphqlRequest({
      query,
      variables: { id: pageId },
    });
    return data.pages.single;
  } catch (error: any) {
    console.error(`[WikiJS] getWikiPage ${pageId} 失敗:`, error.message);
    return null;
  }
}

// ── 更新頁面 ──

export interface UpdatePageResult {
  success: boolean;
  error?: string;
}

/**
 * 更新 Wiki.js 頁面內容
 */
export async function updateWikiPage(
  pageId: number,
  content: string,
  title?: string,
  description?: string,
): Promise<UpdatePageResult> {
  // 需要先取得原始頁面來得到 tags/path 等必要欄位
  const original = await getWikiPage(pageId);
  if (!original) {
    return { success: false, error: `找不到頁面 id=${pageId}` };
  }

  const mutation = `
    mutation UpdatePage(
      $id: Int!,
      $content: String!,
      $description: String!,
      $editor: String!,
      $isPublished: Boolean!,
      $isPrivate: Boolean!,
      $locale: String!,
      $path: String!,
      $tags: [String]!,
      $title: String!
    ) {
      pages {
        update(
          id: $id,
          content: $content,
          description: $description,
          editor: $editor,
          isPrivate: $isPrivate,
          isPublished: $isPublished,
          locale: $locale,
          path: $path,
          tags: $tags,
          title: $title
        ) {
          responseResult {
            succeeded
            errorCode
            slug
            message
          }
          page {
            id
            updatedAt
          }
        }
      }
    }
  `;

  try {
    const data = await graphqlRequest({
      query: mutation,
      variables: {
        id: pageId,
        content,
        description: description ?? original.description ?? '',
        editor: 'markdown',
        isPublished: true,
        isPrivate: false,
        locale: 'zh-tw',
        path: original.path,
        tags: [],
        title: title ?? original.title,
      },
    });

    const result = data.pages.update;
    if (!result.responseResult.succeeded) {
      return {
        success: false,
        error: result.responseResult.message || result.responseResult.slug,
      };
    }

    return { success: true };
  } catch (error: any) {
    console.error(`[WikiJS] updateWikiPage ${pageId} 失敗:`, error.message);
    return { success: false, error: error.message };
  }
}

// ── 附加內容到頁面 ──

/**
 * 在頁面末尾附加內容
 */
export async function appendToWikiPage(
  pageId: number,
  appendContent: string,
): Promise<UpdatePageResult> {
  const page = await getWikiPage(pageId);
  if (!page) {
    return { success: false, error: `找不到頁面 id=${pageId}` };
  }

  const newContent = (page.content || '') + '\n\n' + appendContent;
  return updateWikiPage(pageId, newContent);
}

// ── 替換頁面內容 ──

/**
 * 把頁面中的舊文字替換成新文字
 */
export async function replaceInWikiPage(
  pageId: number,
  oldText: string,
  newText: string,
): Promise<UpdatePageResult> {
  const page = await getWikiPage(pageId);
  if (!page) {
    return { success: false, error: `找不到頁面 id=${pageId}` };
  }

  if (!page.content || !page.content.includes(oldText)) {
    return { success: false, error: `頁面中找不到文字「${oldText}」` };
  }

  const newContent = page.content.split(oldText).join(newText);
  return updateWikiPage(pageId, newContent);
}

// ── 使用者對應（快取） ──

let userCache: Array<{ id: number; name: string; email: string }> | null = null;
let userCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 分鐘

async function getWikiUsers(): Promise<Array<{ id: number; name: string; email: string }>> {
  if (userCache && Date.now() - userCacheTime < CACHE_TTL) {
    return userCache;
  }

  const query = `{ users { list { id name email isActive } } }`;
  try {
    const data = await graphqlRequest({ query });
    userCache = (data.users.list as any[])
      .filter((u) => u.isActive)
      .map((u) => ({ id: u.id, name: u.name, email: u.email }));
    userCacheTime = Date.now();
    return userCache;
  } catch (error: any) {
    console.error('[WikiJS] 取得使用者清單失敗:', error.message);
    return [];
  }
}

/**
 * 依 email 或姓名找到 Wiki.js 使用者 ID
 */
export async function lookupWikiUserId(emailOrName: string): Promise<number | null> {
  if (!emailOrName) return null;
  const users = await getWikiUsers();
  const key = emailOrName.toLowerCase().trim();
  // 取出 email 的 local-part（@ 前面）— 跨 domain 比對用
  // 例：jane.doe@company-a.com 的 local-part 是 jane.doe
  const keyLocal = key.includes('@') ? key.split('@')[0] : key;

  // 1. email 完全比對
  const byEmail = users.find((u) => u.email.toLowerCase() === key);
  if (byEmail) return byEmail.id;

  // 2. email local-part 跨 domain 比對
  //    用於組織有多個 email domain 的情況（例如 Teams AAD 用 A domain，KM 用 B domain）
  //    例：Teams 的 jane.doe@company-a.com 對到 Wiki.js 的 jane.doe@company-b.com
  const byLocalPart = users.find((u) => u.email.toLowerCase().split('@')[0] === keyLocal);
  if (byLocalPart) return byLocalPart.id;

  // 3. 純 local-part 輸入（沒有 @）→ 直接比對 email 前綴
  if (!key.includes('@')) {
    const byPrefix = users.find((u) => u.email.toLowerCase().startsWith(key + '@'));
    if (byPrefix) return byPrefix.id;
  }

  // 4. 姓名完全比對
  const byName = users.find((u) => u.name.toLowerCase() === key);
  if (byName) return byName.id;

  // 5. 姓名包含比對（"Jean Shien" 包含 "Jean"）
  const byNameContains = users.find((u) => u.name.toLowerCase().includes(key) || key.includes(u.name.toLowerCase()));
  if (byNameContains) return byNameContains.id;

  return null;
}

/**
 * 直接用 SQL 更新 Wiki.js 頁面的 authorId + creatorId
 * (因為 API Token 不綁使用者，建立者/作者會預設成 admin)
 * Wiki.js UI 的「由 XXX 建立」顯示的是 creatorId，「由 XXX 更新」顯示的是 authorId，
 * 兩欄都要改，否則 UI 還是會看到 admin。
 * 更新後自動清除 Wiki.js 頁面快取，讓 UI 立即反應。
 */
export async function setPageAuthor(pageId: number, userId: number): Promise<boolean> {
  try {
    const db = await getKmDb();
    const result = await db.request()
      .input('pageId', pageId)
      .input('userId', userId)
      .query(`
        UPDATE [dbo].[pages]
        SET authorId = @userId, creatorId = @userId
        WHERE id = @pageId
      `);
    const rows = result.rowsAffected?.[0] || 0;
    console.log(`[WikiJS] setPageAuthor page=${pageId} user=${userId} (authorId+creatorId) rows=${rows}`);

    // 清除 Wiki.js 頁面快取（不然 UI 會繼續顯示舊作者）
    if (rows > 0) {
      try {
        await flushWikiPageCache();
      } catch (err: any) {
        console.error('[WikiJS] flushCache 失敗:', err.message);
      }
    }

    return rows > 0;
  } catch (error: any) {
    console.error('[WikiJS] setPageAuthor 失敗:', error.message);
    return false;
  }
}

// ── 上傳資產（圖片）──

export interface UploadAssetResult {
  success: boolean;
  filename?: string; // Wiki.js 產生的檔名（可能跟原檔名不同，有 slug 化）
  url?: string;      // 可直接在 markdown 中引用的 URL（例如 /foo.jpg）
  error?: string;
}

/**
 * 上傳圖片到 Wiki.js assets，之後可在頁面 markdown 中用 ![](url) 引用
 * Wiki.js REST 上傳端點：POST /u/<folderId> (multipart/form-data)
 *
 * @param buffer 圖片 binary
 * @param filename 檔名（副檔名會影響 mime 推斷）
 * @param contentType 例 image/jpeg
 * @param folderId 0 = 根資料夾
 */
export async function uploadWikiAsset(
  buffer: Buffer,
  filename: string,
  contentType: string,
  folderId = 0,
): Promise<UploadAssetResult> {
  if (!config.wikijs.apiToken) {
    return { success: false, error: 'WIKIJS_API_TOKEN 未設定' };
  }

  // Wiki.js /u/ 端點 base URL（取 apiUrl 的 origin，把 /graphql 去掉）
  const apiUrl = config.wikijs.apiUrl;
  const origin = apiUrl.replace(/\/graphql\/?$/, '').replace(/\/$/, '');
  const uploadUrl = `${origin}/u`;

  try {
    const form = new FormData();
    form.append('mediaUpload', JSON.stringify({ folderId }));
    form.append('mediaFile', new Blob([buffer], { type: contentType }), filename);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.wikijs.apiToken}`,
      },
      body: form as any,
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Wiki.js 上傳失敗 HTTP ${response.status}: ${text.slice(0, 200)}` };
    }

    const text = await response.text();
    // Wiki.js 成功時回傳可能是 JSON array、空字串或 "ok"。統一透過後查詢 assets 拿 URL
    console.log(`[WikiJS] asset upload response: ${text.slice(0, 200)}`);

    // 用 GraphQL 查詢剛上傳的檔案（取最近的同 filename 那筆）
    const asset = await findRecentAssetByFilename(filename);
    if (!asset) {
      return { success: false, error: '上傳後找不到 asset（Wiki.js GraphQL 查不到）' };
    }

    // Wiki.js 預設把檔案用 slug 化檔名放在 /<filename>（根）或 /<folder-path>/<filename>
    const url = `/${asset.filename}`;
    return { success: true, filename: asset.filename, url };
  } catch (error: any) {
    console.error('[WikiJS] 上傳 asset 失敗:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 用檔名反查最近上傳的 asset（取 filename 符合、建立時間最新的一筆）
 * 因為 /u 端點只回傳 HTML/空字串，不直接給 asset id，需要事後查詢
 */
async function findRecentAssetByFilename(originalFilename: string): Promise<{ id: number; filename: string } | null> {
  const query = `
    query {
      assets {
        list(kind: IMAGE) {
          id
          filename
          createdAt
        }
      }
    }
  `;

  try {
    const data = await graphqlRequest<{ assets: { list: Array<{ id: number; filename: string; createdAt: string }> } }>({ query });
    const items = data.assets?.list || [];

    // Wiki.js slug 化規則：大部分小寫 + 數字 + dash，但保留副檔名
    const baseName = originalFilename.replace(/\.[^.]+$/, '').toLowerCase();
    const ext = originalFilename.match(/\.[^.]+$/)?.[0] || '';

    // 先找檔名完全相符的（上傳後 Wiki.js 幫我們命名成 slug 化版本）
    const candidates = items
      .filter((a) => a.filename.toLowerCase().endsWith(ext) && a.filename.toLowerCase().includes(baseName))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (candidates.length > 0) return candidates[0];

    // 沒找到完全符合的 → 用「最新上傳且副檔名相同」的
    const sortedByTime = items
      .filter((a) => a.filename.toLowerCase().endsWith(ext))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return sortedByTime[0] || null;
  } catch (error: any) {
    console.error('[WikiJS] 查詢 asset 失敗:', error.message);
    return null;
  }
}

/**
 * 清除 Wiki.js 頁面快取
 */
export async function flushWikiPageCache(): Promise<void> {
  const mutation = `
    mutation {
      pages {
        flushCache {
          responseResult {
            succeeded
            message
          }
        }
      }
    }
  `;
  await graphqlRequest({ query: mutation });
  console.log('[WikiJS] 頁面快取已清除');
}
