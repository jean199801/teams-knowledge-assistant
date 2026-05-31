import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

/**
 * 清洗文件內容
 * Wiki.js 的 content 通常就是 Markdown，只需基本清理
 * 少數 HTML 格式的文件才需要轉換
 */
export function cleanContent(content: string, contentType: string): string {
  if (!content) return '';

  if (contentType === 'markdown') {
    return content
      .replace(/<!--.*?-->/gs, '')       // 移除 HTML 註解
      .replace(/\{\.[\w-]+\}/g, '')      // 移除 Wiki.js 特殊屬性 {.class}
      .replace(/\{#[\w-]+\}/g, '')       // 移除 {#id} 屬性
      .replace(/\n{3,}/g, '\n\n')        // 連續空行壓縮為兩行
      .trim();
  }

  // HTML 格式 → 轉 Markdown
  try {
    return turndown.turndown(content).trim();
  } catch {
    // 轉換失敗，嘗試直接去除 HTML 標籤
    return content.replace(/<[^>]*>/g, '').trim();
  }
}
