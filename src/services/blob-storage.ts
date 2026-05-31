import {
  BlobServiceClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
  SASProtocol,
} from '@azure/storage-blob';
import crypto from 'crypto';
import { config } from '../config';

/**
 * Azure Blob Storage 封裝
 * - Container 權限：完全 private
 * - 圖片上傳：不可猜的 UUID 檔名
 * - 顯示圖片：每次產生 1 小時有效的 SAS URL（僅限擁有者）
 * - 刪除：生命週期清理路徑統一走這裡
 */

interface ParsedConnectionString {
  accountName: string;
  accountKey: string;
}

let cachedServiceClient: BlobServiceClient | null = null;
let cachedCredential: StorageSharedKeyCredential | null = null;
let cachedAccountName: string | null = null;

function parseConnectionString(conn: string): ParsedConnectionString {
  const parts = conn.split(';').filter(Boolean);
  const kv: Record<string, string> = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    kv[p.slice(0, idx)] = p.slice(idx + 1);
  }
  const accountName = kv['AccountName'] || '';
  const accountKey = kv['AccountKey'] || '';
  if (!accountName || !accountKey) {
    throw new Error('AZURE_BLOB_CONNECTION_STRING 缺少 AccountName 或 AccountKey');
  }
  return { accountName, accountKey };
}

function getServiceClient(): BlobServiceClient {
  if (cachedServiceClient) return cachedServiceClient;

  const conn = config.blobStorage.connectionString;
  if (!conn) {
    throw new Error('AZURE_BLOB_CONNECTION_STRING 未設定');
  }

  const { accountName, accountKey } = parseConnectionString(conn);
  cachedAccountName = accountName;
  cachedCredential = new StorageSharedKeyCredential(accountName, accountKey);
  cachedServiceClient = BlobServiceClient.fromConnectionString(conn);
  return cachedServiceClient;
}

function getContainerClient() {
  return getServiceClient().getContainerClient(config.blobStorage.containerName);
}

/**
 * 產生 Blob 檔名：userId 前綴 + UUID + 副檔名（純從 contentType 推）
 */
function buildBlobName(userId: string, contentType: string): string {
  const ext = contentTypeToExt(contentType);
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  const uuid = crypto.randomUUID();
  return `${safeUserId}/${uuid}${ext}`;
}

function contentTypeToExt(contentType: string): string {
  switch ((contentType || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '';
  }
}

export interface UploadedBlob {
  blobName: string;
  contentType: string;
  size: number;
}

/**
 * 從圖片原始 bytes 的 magic number 判斷實際格式
 * 當 Teams / fetch response 給的 contentType 是 "image/*" 或缺失時，fallback 用這個
 * 回傳 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null（無法判斷）
 */
export function detectImageMimeType(data: Buffer): string | null {
  if (data.length < 12) return null;

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return 'image/png';

  // GIF: "GIF87a" or "GIF89a"
  if (
    data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 &&
    (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61
  ) return 'image/gif';

  // WebP: RIFF????WEBP (bytes 0-3 "RIFF", 8-11 "WEBP")
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return 'image/webp';

  return null;
}

/**
 * 上傳一張圖到 Blob
 */
export async function uploadImage(
  userId: string,
  data: Buffer,
  contentType: string,
): Promise<UploadedBlob> {
  if (!config.blobStorage.allowedContentTypes.includes(contentType.toLowerCase())) {
    throw new Error(`不支援的圖片格式：${contentType}`);
  }
  if (data.length > config.blobStorage.maxFileSizeBytes) {
    throw new Error(`圖片超過 ${Math.round(config.blobStorage.maxFileSizeBytes / 1024 / 1024)}MB 上限`);
  }

  const container = getContainerClient();
  const blobName = buildBlobName(userId, contentType);
  const blockBlob = container.getBlockBlobClient(blobName);

  await blockBlob.uploadData(data, {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobCacheControl: 'private, max-age=3600',
    },
  });

  console.log(`[BlobStorage] Uploaded ${blobName} (${data.length} bytes)`);
  return { blobName, contentType, size: data.length };
}

/**
 * 產生 SAS URL（預設 60 分鐘有效）
 * 呼叫端必須先驗證請求者是圖片擁有者
 */
export function generateSasUrl(blobName: string, durationMinutes?: number): string {
  getServiceClient(); // 確保 credential 初始化
  if (!cachedCredential || !cachedAccountName) {
    throw new Error('Blob credential 未初始化');
  }

  const minutes = durationMinutes ?? config.blobStorage.sasDurationMinutes;
  const startsOn = new Date(Date.now() - 60 * 1000); // 回推 1 分鐘避免 clock skew
  const expiresOn = new Date(Date.now() + minutes * 60 * 1000);

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: config.blobStorage.containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    },
    cachedCredential,
  ).toString();

  return `https://${cachedAccountName}.blob.core.windows.net/${config.blobStorage.containerName}/${blobName}?${sasToken}`;
}

/**
 * 下載 Blob 二進位內容（發布流程用：把 Blob 轉存到 KM / Docs / Notion）
 */
export async function downloadImage(blobName: string): Promise<Buffer> {
  const container = getContainerClient();
  const blob = container.getBlockBlobClient(blobName);
  const downloaded = await blob.downloadToBuffer();
  return downloaded;
}

/**
 * 刪除一張圖
 */
export async function deleteImage(blobName: string): Promise<void> {
  try {
    const container = getContainerClient();
    await container.getBlockBlobClient(blobName).deleteIfExists();
    console.log(`[BlobStorage] Deleted ${blobName}`);
  } catch (err: any) {
    console.error(`[BlobStorage] Delete failed for ${blobName}:`, err.message);
  }
}

/**
 * 批次刪除（發布/完成/刪除等生命週期觸發時用）
 */
export async function deleteImages(blobNames: string[]): Promise<void> {
  await Promise.all(blobNames.map((name) => deleteImage(name)));
}

/**
 * 基本健康檢查（開發期確認連線 OK）
 */
export async function blobHealthCheck(): Promise<{ ok: boolean; error?: string }> {
  try {
    const container = getContainerClient();
    const exists = await container.exists();
    if (!exists) {
      return { ok: false, error: `Container "${config.blobStorage.containerName}" 不存在` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
