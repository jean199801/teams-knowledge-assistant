import { RagResponse } from '../services/rag';
import { config } from '../config';

/**
 * 建立回答用的 Adaptive Card
 * 顯示問題、回答內容和參考來源（可點擊連結到 KM）
 */
export function createAnswerCard(question: string, result: RagResponse): object {
  const sourceItems = result.sources.map((s) => {
    // 根據來源類型產生不同連結
    let sourceUrl: string;
    let sourceIcon: string;
    if (s.sourceType === 'google_docs') {
      // description 存放原始 Google Doc ID
      sourceUrl = `https://docs.google.com/document/d/${s.description}/view`;
      sourceIcon = '📝';
    } else if (s.sourceType === 'notion') {
      // description 存放原始 Notion page ID（已去除 dash）
      sourceUrl = `https://www.notion.so/${s.description}`;
      sourceIcon = '📓';
    } else {
      sourceUrl = `${config.kmBaseUrl}/${s.path}`;
      sourceIcon = '📄';
    }
    return {
      type: 'ColumnSet',
      selectAction: {
        type: 'Action.OpenUrl',
        url: sourceUrl,
      },
      columns: [
        {
          type: 'Column',
          width: 'auto',
          items: [
            {
              type: 'TextBlock',
              text: sourceIcon,
              size: 'Small',
            },
          ],
          verticalContentAlignment: 'Center',
        },
        {
          type: 'Column',
          width: 'stretch',
          items: [
            {
              type: 'TextBlock',
              text: s.title,
              size: 'Small',
              color: 'Accent',
              wrap: true,
            },
          ],
          verticalContentAlignment: 'Center',
        },
        {
          type: 'Column',
          width: 'auto',
          items: [
            {
              type: 'TextBlock',
              text: `${Math.round(s.score * 100)}%`,
              size: 'Small',
              color: 'Light',
            },
          ],
          verticalContentAlignment: 'Center',
        },
      ],
    };
  });

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      // 回答內容
      {
        type: 'TextBlock',
        text: result.answer,
        wrap: true,
        size: 'Default',
      },
      // 分隔線
      {
        type: 'TextBlock',
        text: '─────────────────────',
        color: 'Light',
        size: 'Small',
        spacing: 'Medium',
      },
      // 參考來源標題
      {
        type: 'TextBlock',
        text: '📚 參考來源',
        weight: 'Bolder',
        size: 'Small',
        spacing: 'Small',
      },
      // 來源列表
      ...sourceItems,
    ],
  };
}

/**
 * 建立錯誤提示 Adaptive Card
 */
export function createErrorCard(errorMessage: string): object {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '⚠️ 處理發生錯誤',
        weight: 'Bolder',
        color: 'Attention',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: '很抱歉，處理您的問題時發生錯誤。請稍後再試，或聯繫技術部門。',
        wrap: true,
        size: 'Default',
      },
      {
        type: 'TextBlock',
        text: `錯誤訊息：${errorMessage}`,
        wrap: true,
        size: 'Small',
        color: 'Light',
        isSubtle: true,
      },
    ],
  };
}

/**
 * 建立歡迎訊息 Adaptive Card
 */
export function createWelcomeCard(): object {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '🤖 後勤知識助手',
        weight: 'Bolder',
        size: 'Large',
      },
      {
        type: 'TextBlock',
        text: '你好！我是**後勤知識助手**，可以回答公司系統、流程、業務規則相關的問題。',
        wrap: true,
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text: '💡 你可以試試這些問題：',
        weight: 'Bolder',
        size: 'Default',
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text: '• 運費怎麼算？折抵規則是什麼？\n• 異常訂單怎麼查？怎麼修復？\n• 箱裝出貨日排程什麼時候跑？\n• 客人可以用 LINE 改什麼資料？\n• 庫存怎麼批次更新？',
        wrap: true,
        size: 'Default',
        spacing: 'Small',
      },
      {
        type: 'TextBlock',
        text: '─────────────────────',
        color: 'Light',
        size: 'Small',
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text: '📌 1:1 私訊我或在群組中 @後勤知識助手 都可以提問',
        wrap: true,
        size: 'Small',
        color: 'Light',
      },
    ],
  };
}
