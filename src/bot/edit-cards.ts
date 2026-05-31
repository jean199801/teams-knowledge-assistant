import { EditCandidate } from '../services/kb-edit';
import { EditDocResult } from '../services/edit-log';
import { config } from '../config';

/**
 * 依 candidate 型別產生「開啟文件」連結，讓用戶先預覽再決定
 */
function getCandidateUrl(c: EditCandidate): string {
  if (c.sourceType === 'google_docs') {
    return `https://docs.google.com/document/d/${c.description}/edit`;
  }
  if (c.sourceType === 'notion') {
    return `https://www.notion.so/${c.description}`;
  }
  // km_system
  return `${config.kmBaseUrl}/${c.path}`;
}

/**
 * 修改預覽卡片：列出所有受影響文件，每份有「確認」「跳過」按鈕
 */
export function createEditPreviewCard(
  oldText: string,
  newText: string,
  candidates: EditCandidate[],
  editSessionId: string,
): object {
  const platformIcon: Record<string, string> = {
    google_docs: '📝',
    km_system: '📄',
    notion: '📓',
  };

  const docRows = candidates.map((c) => ({
    type: 'Container',
    items: [
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: `${platformIcon[c.sourceType] || '📄'} **${c.title}**`,
                wrap: true,
                size: 'Small',
              },
              {
                type: 'TextBlock',
                text: c.matchSnippet.replace(oldText, `**${oldText}**`),
                wrap: true,
                size: 'Small',
                color: 'Light',
              },
            ],
          },
          {
            type: 'Column',
            width: 'auto',
            items: [
              {
                type: 'ActionSet',
                actions: [
                  {
                    type: 'Action.OpenUrl',
                    title: '🔗 查看',
                    url: getCandidateUrl(c),
                  },
                  {
                    type: 'Action.Submit',
                    title: '✅ 修改',
                    data: {
                      action: 'edit_document',
                      editSessionId,
                      sourceId: c.sourceId,
                      decision: 'approve',
                    },
                  },
                  {
                    type: 'Action.Submit',
                    title: '⏭ 跳過',
                    data: {
                      action: 'edit_document',
                      editSessionId,
                      sourceId: c.sourceId,
                      decision: 'skip',
                    },
                  },
                ],
              },
            ],
            verticalContentAlignment: 'Center',
          },
        ],
      },
    ],
    separator: true,
  }));

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '✏️ 知識庫文件修改',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'FactSet',
        facts: [
          { title: '舊文字', value: oldText },
          { title: '新文字', value: newText },
        ],
      },
      {
        type: 'TextBlock',
        text: `找到 **${candidates.length}** 份包含此文字的文件，請逐一確認：`,
        wrap: true,
        spacing: 'Medium',
      },
      ...docRows,
    ],
  };
}

/**
 * 修改完成結果卡片
 */
export function createEditResultCard(
  oldText: string,
  newText: string,
  results: EditDocResult[],
): object {
  const approved = results.filter((r) => r.action === 'approved');
  const skipped = results.filter((r) => r.action === 'skipped');
  const success = approved.filter((r) => r.editResult?.success);
  const failed = approved.filter((r) => !r.editResult?.success);

  const platformIcon: Record<string, string> = {
    google_docs: '📝',
    km_system: '📄',
    notion: '📓',
  };

  const lines: string[] = [];

  if (success.length > 0) {
    lines.push('**✅ 修改成功：**');
    for (const r of success) {
      lines.push(`- ${platformIcon[r.sourceType] || '📄'} ${r.title}`);
    }
  }

  if (failed.length > 0) {
    lines.push('');
    lines.push('**❌ 修改失敗：**');
    for (const r of failed) {
      lines.push(`- ${platformIcon[r.sourceType] || '📄'} ${r.title}: ${r.editResult?.error || '未知錯誤'}`);
    }
  }

  if (skipped.length > 0) {
    lines.push('');
    lines.push('**⏭ 已跳過：**');
    for (const r of skipped) {
      lines.push(`- ${platformIcon[r.sourceType] || '📄'} ${r.title}`);
    }
  }

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '✏️ 修改完成',
        weight: 'Bolder',
        size: 'Medium',
        color: success.length > 0 ? 'Good' : 'Attention',
      },
      {
        type: 'FactSet',
        facts: [
          { title: '修改', value: `「${oldText}」→「${newText}」` },
          { title: '成功', value: `${success.length} 份` },
          { title: '跳過', value: `${skipped.length} 份` },
          ...(failed.length > 0 ? [{ title: '失敗', value: `${failed.length} 份` }] : []),
        ],
      },
      {
        type: 'TextBlock',
        text: lines.join('\n'),
        wrap: true,
        size: 'Small',
        spacing: 'Medium',
      },
    ],
  };
}

/**
 * 附加內容預覽卡片：列出目標文件，每份都可以先「查看」再決定要不要「附加」
 */
export function createAppendPreviewCard(
  appendContent: string,
  candidates: EditCandidate[],
  editSessionId: string,
): object {
  const platformIcon: Record<string, string> = {
    google_docs: '📝',
    km_system: '📄',
    notion: '📓',
  };
  const platformLabel: Record<string, string> = {
    google_docs: 'Google Docs',
    km_system: 'KM 系統',
    notion: 'Notion',
  };

  const preview = appendContent.length > 100 ? appendContent.slice(0, 100) + '...' : appendContent;

  // 每份候選文件變成一個 Container，內含標題 + 路徑 + 兩個按鈕
  const docRows = candidates.slice(0, 6).map((c) => ({
    type: 'Container',
    separator: true,
    spacing: 'Medium',
    items: [
      {
        type: 'TextBlock',
        text: `${platformIcon[c.sourceType] || '📄'} **${c.title}**`,
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: `${platformLabel[c.sourceType] || ''}・${c.path || ''}`,
        wrap: true,
        size: 'Small',
        color: 'Light',
        spacing: 'None',
      },
      {
        type: 'ActionSet',
        actions: [
          {
            type: 'Action.OpenUrl',
            title: '🔗 先查看',
            url: getCandidateUrl(c),
          },
          {
            type: 'Action.Submit',
            title: '✅ 附加到這份',
            style: 'positive',
            data: {
              action: 'append_document',
              editSessionId,
              sourceId: c.sourceId,
            },
          },
        ],
      },
    ],
  }));

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '📎 附加內容到文件',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: '要附加的內容：',
        weight: 'Bolder',
        size: 'Small',
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text: preview,
        wrap: true,
        size: 'Small',
        color: 'Light',
      },
      {
        type: 'TextBlock',
        text: `找到 **${candidates.length}** 份可能的目標文件，請先點「🔗 先查看」確認內容，再按「✅ 附加到這份」：`,
        wrap: true,
        spacing: 'Medium',
      },
      ...docRows,
    ],
  };
}

/**
 * 附加成功卡片（含連結）
 */
export function createAppendSuccessCard(title: string, platform: string, url: string): object {
  const platformNames: Record<string, string> = {
    google_docs: '📝 Google Docs',
    km_system: '📄 KM 系統',
    notion: '📓 Notion',
  };

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '✅ 內容已附加',
        weight: 'Bolder',
        color: 'Good',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: `已附加到 ${platformNames[platform] || platform} 的「${title}」`,
        wrap: true,
      },
    ],
    actions: url ? [
      {
        type: 'Action.OpenUrl',
        title: '🔗 開啟文件',
        url,
      },
    ] : [],
  };
}

/**
 * 找不到匹配文件
 */
export function createEditNoMatchCard(searchText: string): object {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '✏️ 知識庫文件修改',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: `在知識庫中找不到包含「${searchText}」的文件。`,
        wrap: true,
        color: 'Attention',
      },
      {
        type: 'TextBlock',
        text: '提示：請確認文字完全一致（包含標點符號和空格）。',
        wrap: true,
        size: 'Small',
        color: 'Light',
      },
    ],
  };
}
