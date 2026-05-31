import { PageRecord } from './extract';
import { cleanContent } from './clean';
import { config } from '../config';

// OpenAI embedding 最大 8192 tokens，中文約 1 字 = 2 tokens
// 設定安全上限為 3000 字元，確保不會超過 token 限制
const EMBEDDING_MAX_CHARS = 3000;

export interface Chunk {
  id: string;
  content: string;
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

/**
 * 將一篇文件切割成多個片段
 * 策略：先按 ## 標題切，如果單段超過 maxLength 再按段落切
 * sourceType: 'km_system' | 'google_docs' | 'notion' (預設 km_system)
 */
export function chunkPage(
  page: PageRecord,
  sourceType: 'km_system' | 'google_docs' | 'notion' = 'km_system',
): Chunk[] {
  const markdown = cleanContent(page.content, page.contentType);
  if (!markdown) return [];

  const category = page.path.split('/')[0] || 'general';
  const maxLen = config.etl.chunkMaxLength;

  // 先按 ## 標題切割
  const sections = markdown.split(/(?=^## )/gm).filter((s) => s.trim());

  const chunks: Chunk[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxLen) {
      chunks.push(
        createChunk(page, category, chunks.length, trimmed, sourceType),
      );
    } else {
      const subChunks = splitByParagraph(trimmed, maxLen);
      for (const sub of subChunks) {
        chunks.push(
          createChunk(page, category, chunks.length, sub, sourceType),
        );
      }
    }
  }

  // 如果整篇文件沒有 ## 標題，按段落切割
  if (chunks.length === 0 && markdown.trim()) {
    if (markdown.trim().length <= maxLen) {
      chunks.push(
        createChunk(page, category, 0, markdown.trim(), sourceType),
      );
    } else {
      const subChunks = splitByParagraph(markdown.trim(), maxLen);
      for (const sub of subChunks) {
        chunks.push(
          createChunk(page, category, chunks.length, sub, sourceType),
        );
      }
    }
  }

  return chunks;
}

function createChunk(
  page: PageRecord,
  category: string,
  index: number,
  content: string,
  sourceType: 'km_system' | 'google_docs' | 'notion' = 'km_system',
): Chunk {
  // 在片段前加上文件標題，幫助 AI 理解上下文
  const sourceLabel =
    sourceType === 'google_docs' ? '[Google Docs] ' :
    sourceType === 'notion' ? '[Notion] ' : '';
  let fullContent = `# ${sourceLabel}${page.title}\n\n${content}`;

  // 安全截斷：確保不超過 embedding 的 token 限制
  if (fullContent.length > EMBEDDING_MAX_CHARS) {
    fullContent = fullContent.slice(0, EMBEDDING_MAX_CHARS);
  }

  const prefix = sourceType === 'google_docs' ? 'gdoc' : sourceType === 'notion' ? 'notion' : 'km';

  return {
    id: `${prefix}_${page.id}_${index}`,
    content: fullContent,
    metadata: {
      sourceType,
      sourceId: String(page.id),
      title: page.title,
      description: page.description || '',
      path: page.path,
      category,
      chunkIndex: index,
      updatedAt: page.updatedAt instanceof Date ? page.updatedAt.toISOString() : String(page.updatedAt),
    },
  };
}

/**
 * 按段落切割長文（保持段落完整性）
 */
function splitByParagraph(text: string, maxLen: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const result: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxLen && current) {
      result.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}
