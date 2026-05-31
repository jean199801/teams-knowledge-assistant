import { Note, Reminder, SearchResult, BlobImage } from '../services/personal-store';
import { generateSasUrl } from '../services/blob-storage';

/**
 * 產生圖片縮圖列（Adaptive Card Image elements）
 * 每張圖用 1 小時有效的 SAS URL，每次重新渲染都重新簽
 */
function imageRow(images: BlobImage[] | undefined, maxShown = 3): any[] {
  if (!images || images.length === 0) return [];
  const shown = images.slice(0, maxShown);
  const columns = shown.map((img) => ({
    type: 'Column',
    width: 'auto',
    items: [
      {
        type: 'Image',
        url: safeSasUrl(img.blobName),
        size: 'Medium',
        style: 'Default',
      },
    ],
  }));
  const extraCount = images.length - shown.length;
  if (extraCount > 0) {
    columns.push({
      type: 'Column',
      width: 'auto',
      items: [
        {
          type: 'TextBlock',
          text: `+${extraCount}`,
          weight: 'Bolder',
          size: 'Large',
          color: 'Light',
        } as any,
      ],
    });
  }
  return [{ type: 'ColumnSet', columns, spacing: 'Small' }];
}

/** 產生 SAS URL；若失敗（例如 Blob 沒設好）回傳空字串避免破卡 */
function safeSasUrl(blobName: string): string {
  try {
    return generateSasUrl(blobName);
  } catch {
    return '';
  }
}

/**
 * # 指令選單卡片
 * 用戶輸入 "#" 時顯示
 */
export function createCommandMenuCard(): object {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '📋 個人小助理',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: '請選擇要執行的操作：',
        wrap: true,
        spacing: 'Small',
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: '📝 記事',
        data: { action: 'command_menu', command: 'note_prompt' },
      },
      {
        type: 'Action.Submit',
        title: '⏰ 提醒',
        data: { action: 'command_menu', command: 'reminder_prompt' },
      },
      {
        type: 'Action.Submit',
        title: '✅ 完成待辦',
        data: { action: 'command_menu', command: 'complete_list' },
      },
      {
        type: 'Action.Submit',
        title: '📓 筆記列表',
        data: { action: 'command_menu', command: 'note_list' },
      },
      {
        type: 'Action.Submit',
        title: '📤 發布到知識庫',
        data: { action: 'command_menu', command: 'publish_list' },
      },
      {
        type: 'Action.Submit',
        title: '❓ 說明',
        data: { action: 'command_menu', command: 'help' },
      },
    ],
  };
}

/**
 * 提示用戶輸入內容的卡片
 */
export function createInputPromptCard(type: 'note' | 'reminder'): object {
  const title = type === 'note' ? '📝 記事' : '⏰ 新增提醒';
  const placeholder = type === 'note'
    ? '輸入要記錄的內容...'
    : '輸入提醒內容（可加日期，如：4/15 準備會議）';

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: title,
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'Input.Text',
        id: 'inputContent',
        placeholder,
        isMultiline: true,
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: '確認',
        style: 'positive',
        data: { action: `submit_${type}` },
      },
      {
        type: 'Action.Submit',
        title: '取消',
        data: { action: 'cancel_input' },
      },
    ],
  };
}

/**
 * 筆記已儲存確認
 */
export function createNoteConfirmCard(note: Note): object {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '✅ 已記錄',
        weight: 'Bolder',
        color: 'Good',
      },
      {
        type: 'TextBlock',
        text: note.content,
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: `#${note.id} · ${formatDate(note.createdAt)}`,
        size: 'Small',
        color: 'Light',
      },
    ],
  };
}

/**
 * 提醒已新增確認
 */
export function createReminderConfirmCard(reminder: Reminder): object {
  const dueDateText = reminder.dueDate
    ? `📅 ${reminder.dueDate}${reminder.dueTime ? ' ' + reminder.dueTime : ''}`
    : '無指定日期';
  const timeHint = reminder.dueTime
    ? '（會在到期前 30 分鐘單獨提醒你）'
    : '';
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '⏰ 已新增提醒',
        weight: 'Bolder',
        color: 'Good',
      },
      {
        type: 'TextBlock',
        text: reminder.content,
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: `#${reminder.id} · ${dueDateText}`,
        size: 'Small',
        color: 'Light',
      },
      ...(timeHint ? [{
        type: 'TextBlock' as const,
        text: timeHint,
        size: 'Small',
        color: 'Accent',
        spacing: 'Small',
      }] : []),
    ],
  };
}

/**
 * 待辦清單（含完成按鈕）
 */
export function createReminderListCard(reminders: Reminder[]): object {
  if (reminders.length === 0) {
    return {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: [
        {
          type: 'TextBlock',
          text: '✨ 沒有待辦事項',
          weight: 'Bolder',
        },
        {
          type: 'TextBlock',
          text: '目前沒有未完成的提醒，太棒了！',
          wrap: true,
          color: 'Light',
        },
      ],
    };
  }

  const items = reminders.flatMap((r) => {
    const dueBadge = r.dueDate ? ` 📅 ${r.dueDate}` : '';
    const imageBadge = r.images && r.images.length > 0 ? ` 📸×${r.images.length}` : '';
    const isOverdue = r.dueDate && r.dueDate <= new Date().toISOString().slice(0, 10);
    const row: any = {
      type: 'ColumnSet',
      columns: [
        {
          type: 'Column',
          width: 'stretch',
          items: [
            {
              type: 'TextBlock',
              text: `**#${r.id}** ${r.content}${dueBadge}${imageBadge}`,
              wrap: true,
              color: isOverdue ? 'Attention' : 'Default',
            },
          ],
          verticalContentAlignment: 'Center',
        },
        {
          type: 'Column',
          width: 'auto',
          items: [
            {
              type: 'ActionSet',
              actions: [
                {
                  type: 'Action.Submit',
                  title: '☐ 完成',
                  style: 'positive',
                  data: { action: 'complete_reminder', reminderId: r.id },
                },
              ],
            },
          ],
          verticalContentAlignment: 'Center',
        },
      ],
    };
    return [row, ...imageRow(r.images, 3)];
  });

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: `📋 待辦事項 (${reminders.length})`,
        weight: 'Bolder',
        size: 'Medium',
      },
      ...items,
    ],
  };
}

/**
 * 筆記列表
 */
export function createNoteListCard(notes: Note[]): object {
  if (notes.length === 0) {
    return {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: [
        {
          type: 'TextBlock',
          text: '📓 還沒有筆記',
          weight: 'Bolder',
        },
        {
          type: 'TextBlock',
          text: '輸入 #記 加上內容就可以開始記錄！',
          wrap: true,
          color: 'Light',
        },
      ],
    };
  }

  // 每則筆記 → 一個 Container，內含文字 + 圖片縮圖 + 發布/刪除兩個按鈕
  const noteContainers = notes.map((n) => {
    const publishBadge = n.published ? ` ✅ 已發布(${n.publishedTo})` : '';
    const imageBadge = n.images && n.images.length > 0 ? ` 📸×${n.images.length}` : '';
    const preview = n.content.length > 60 ? n.content.slice(0, 60) + '...' : n.content;
    return {
      type: 'Container',
      separator: true,
      spacing: 'Medium',
      items: [
        {
          type: 'TextBlock',
          text: `**#${n.id}** ${preview}${publishBadge}${imageBadge}`,
          wrap: true,
          size: 'Small',
        },
        ...imageRow(n.images, 3),
        {
          type: 'TextBlock',
          text: formatDate(n.createdAt),
          size: 'Small',
          color: 'Light',
          spacing: 'None',
        },
        {
          type: 'ActionSet',
          actions: [
            {
              type: 'Action.Submit',
              title: '📤 發布',
              style: 'positive',
              data: { action: 'publish_select_platform', noteId: n.id },
            },
            {
              type: 'Action.Submit',
              title: '🗑 刪除',
              style: 'destructive',
              // 直接刪除、不跳確認卡 — handleDeleteNoteConfirm 會把這張列表卡就地更新
              data: { action: 'delete_note_confirm', noteId: n.id },
            },
          ],
        },
      ],
    };
  });

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: `📓 最近筆記 (${notes.length})`,
        weight: 'Bolder',
        size: 'Medium',
      },
      ...noteContainers,
    ],
  };
}

/**
 * 刪除筆記前的二次確認卡片
 */
export function createDeleteNoteConfirmCard(note: Note): object {
  const preview = note.content.length > 80 ? note.content.slice(0, 80) + '...' : note.content;
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: `🗑 確定要刪除筆記 #${note.id}？`,
        weight: 'Bolder',
        size: 'Medium',
        color: 'Attention',
      },
      {
        type: 'TextBlock',
        text: preview,
        wrap: true,
        size: 'Small',
        color: 'Light',
        spacing: 'Small',
      },
      {
        type: 'TextBlock',
        text: '⚠️ 刪除後無法復原',
        size: 'Small',
        color: 'Warning',
        spacing: 'Small',
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: '✅ 確認刪除',
        style: 'destructive',
        data: { action: 'delete_note_confirm', noteId: note.id },
      },
      {
        type: 'Action.Submit',
        title: '取消',
        data: { action: 'cancel_input' },
      },
    ],
  };
}

/**
 * 搜尋結果
 */
export function createSearchResultCard(keyword: string, results: SearchResult[]): object {
  if (results.length === 0) {
    return {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: [
        {
          type: 'TextBlock',
          text: `🔍 找不到「${keyword}」的相關紀錄`,
          weight: 'Bolder',
          wrap: true,
        },
      ],
    };
  }

  const items = results.map((r) => {
    const icon = r.type === 'note' ? '📝' : '⏰';
    const preview = r.content.length > 60 ? r.content.slice(0, 60) + '...' : r.content;
    return {
      type: 'TextBlock',
      text: `${icon} **#${r.id}** ${preview}  \n_${formatDate(r.createdAt)}_`,
      wrap: true,
      size: 'Small',
      spacing: 'Small',
    };
  });

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: `🔍 搜尋「${keyword}」(${results.length} 筆)`,
        weight: 'Bolder',
        size: 'Medium',
      },
      ...items,
    ],
  };
}

/**
 * 每日提醒推送
 */
export function createDailyReminderCard(userName: string, reminders: Reminder[]): object {
  const items = reminders.map((r) => {
    const dueBadge = r.dueDate ? ` 📅 ${r.dueDate}` : '';
    const isOverdue = r.dueDate && r.dueDate <= new Date().toISOString().slice(0, 10);
    return {
      type: 'ColumnSet',
      columns: [
        {
          type: 'Column',
          width: 'stretch',
          items: [
            {
              type: 'TextBlock',
              text: `**#${r.id}** ${r.content}${dueBadge}`,
              wrap: true,
              color: isOverdue ? 'Attention' : 'Default',
            },
          ],
          verticalContentAlignment: 'Center',
        },
        {
          type: 'Column',
          width: 'auto',
          items: [
            {
              type: 'ActionSet',
              actions: [
                {
                  type: 'Action.Submit',
                  title: '☐ 完成',
                  style: 'positive',
                  data: { action: 'complete_reminder', reminderId: r.id },
                },
              ],
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
      {
        type: 'TextBlock',
        text: `☀️ ${userName}，早安！`,
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: `你有 ${reminders.length} 項待辦事項：`,
        wrap: true,
        spacing: 'Small',
      },
      ...items,
    ],
  };
}

/**
 * AI 建議發布平台卡片
 */
export function createPublishSuggestionCard(
  noteId: number,
  notePreview: string,
  suggestion: { target: string; reason: string },
): object {
  const platformNames: Record<string, string> = {
    notion: '📓 Notion',
    km: '📄 KM 系統',
    gdocs: '📝 Google Docs',
  };

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '📤 發布筆記',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: `**#${noteId}** ${notePreview}`,
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: '─────────────────────',
        color: 'Light',
        size: 'Small',
      },
      {
        type: 'TextBlock',
        text: `🤖 AI 建議：${platformNames[suggestion.target] || suggestion.target}`,
        weight: 'Bolder',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: suggestion.reason,
        wrap: true,
        size: 'Small',
        color: 'Light',
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: '📄 KM',
        data: { action: 'publish_to', noteId, platform: 'km' },
      },
      {
        type: 'Action.Submit',
        title: '📝 Google Docs',
        data: { action: 'publish_to', noteId, platform: 'gdocs' },
      },
    ],
  };
}

/**
 * 群組 @bot 被判斷為個人意圖時，回覆的「請到私訊」卡片。
 * 點按鈕用 deep link 跳到跟 bot 的 1:1 對話，並預填訊息。
 */
export function createPrivateChatRedirectCard(
  intentType: string,
  originalText: string,
  botAppId: string,
): object {
  const intentLabels: Record<string, string> = {
    add_reminder: '新增提醒',
    save_note: '記事',
    query_reminders: '查看待辦',
    complete_reminder: '標記完成',
    search_personal: '搜尋個人筆記',
    help: '說明',
  };
  const label = intentLabels[intentType] || '個人操作';

  // Teams deep link：開啟跟 bot 的 1:1 對話，並預填 message（用戶按 send 才會送出）
  // https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-links#link-to-a-personal-chat-with-a-bot
  const preFilledMessage = encodeURIComponent(originalText);
  const deepLink = `https://teams.microsoft.com/l/chat/0/0?users=28:${botAppId}&message=${preFilledMessage}`;

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: `📩 這看起來是${label}（個人操作）`,
        weight: 'Bolder',
        color: 'Accent',
      },
      {
        type: 'TextBlock',
        text: '為了不打擾群組，個人事項請到私訊處理。點下方按鈕開啟跟我的 1:1 對話，訊息已預填好。',
        wrap: true,
        size: 'Small',
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: '📨 開啟私訊',
        url: deepLink,
      },
    ],
  };
}

/**
 * 通用平台選擇卡片：給定 noteId + 預覽文字，顯示三個平台選項。
 * 用於 MD 檔上傳後的發布入口（也可以給未來其他入口重用）。
 */
export function createPlatformPickerCard(
  noteId: number,
  notePreview: string,
  headline?: string,
): object {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: headline ?? '📤 選擇發布平台',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: notePreview,
        wrap: true,
        size: 'Small',
        color: 'Light',
        spacing: 'Medium',
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: '📄 KM 系統',
        data: { action: 'publish_to', noteId, platform: 'km' },
      },
      {
        type: 'Action.Submit',
        title: '📝 Google Docs',
        data: { action: 'publish_to', noteId, platform: 'gdocs' },
      },
    ],
  };
}

/**
 * AI 建議發布位置卡片
 */
export function createPublishLocationCard(
  noteId: number,
  platform: string,
  locations: Array<{ id: string; name: string }>,
  suggestedId: string,
  suggestReason: string,
): object {
  const platformNames: Record<string, string> = {
    notion: 'Notion',
    km: 'KM 系統',
    gdocs: 'Google Docs',
  };

  const locationChoices = locations.map((loc) => ({
    title: loc.id === suggestedId ? `${loc.name} ⭐ 建議` : loc.name,
    value: loc.id,
  }));

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: `📍 選擇 ${platformNames[platform] || platform} 發布位置`,
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: `🤖 建議：${suggestReason}`,
        wrap: true,
        size: 'Small',
        color: 'Light',
      },
      {
        type: 'Input.ChoiceSet',
        id: 'locationId',
        value: suggestedId,
        choices: locationChoices,
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: '確認發布',
        data: { action: 'publish_confirm', noteId, platform },
      },
    ],
  };
}

/**
 * 發布成功卡片（含連結）
 */
export function createPublishSuccessCard(
  platform: string,
  title: string,
  url: string,
  imageCount = 0,
): object {
  const platformNames: Record<string, string> = {
    notion: '📓 Notion',
    km: '📄 KM 系統',
    gdocs: '📝 Google Docs',
  };

  const facts: Array<{ title: string; value: string }> = [
    { title: '平台', value: platformNames[platform] || platform },
    { title: '標題', value: title },
  ];
  if (imageCount > 0) {
    facts.push({ title: '圖片', value: `${imageCount} 張（已上傳到平台）` });
  }

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '✅ 發布成功！',
        weight: 'Bolder',
        color: 'Good',
        size: 'Medium',
      },
      {
        type: 'FactSet',
        facts,
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: '🔗 開啟文件',
        url,
      },
    ],
  };
}

/**
 * 使用說明
 */
export function createHelpCard(): object {
  const bullet = (text: string, spacing: 'None' | 'Small' = 'Small') => ({
    type: 'TextBlock',
    text,
    wrap: true,
    size: 'Small',
    spacing,
  });

  const sectionHeader = (text: string) => ({
    type: 'TextBlock',
    text,
    weight: 'Bolder',
    spacing: 'Large',
    separator: true,
  });

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '🤖 個人小助理 使用說明',
        weight: 'Bolder',
        size: 'Medium',
      },

      sectionHeader('**📝 筆記 / 提醒 / 待辦**'),
      bullet('• 輸入 **#** → 開啟指令選單'),
      bullet('• **#記** 內容 → 儲存筆記'),
      bullet('• **#筆記** → 查看筆記列表'),
      bullet('• **#提** 內容 → 新增提醒（例：#提 開會 明天下午兩點）'),
      bullet('• **#待** → 查看所有未完成待辦'),
      bullet('• **#完成** → 列出待辦、標記完成'),

      sectionHeader('**📤 發布內容到知識庫**'),
      bullet('• **#發布** 內容 → 直接發布（會自動存成筆記再發）'),
      bullet('• **#發布** 編號 → 發布已存在的筆記'),
      bullet('• 或直接拖 .md 檔進對話 → Bot 自動接手'),
      bullet('• 目標：📄 KM 系統 / 📝 Google Docs（Notion 不支援新建）', 'None'),

      sectionHeader('**✏️ 修改知識庫（KM / Google Docs / Notion）**'),
      bullet('• **#修改 把「舊文字」改成「新文字」** → 替換三大來源中的文字'),
      bullet('• **#修改 在 XX 文件加上 內容** → 在指定文件末尾附加'),
      bullet('• **#追加 在 XX 文件加上 內容** → 同上（另一種寫法）'),
      {
        type: 'TextBlock',
        text: '會列出所有命中文件，可先點「🔗 先查看」預覽，再按「✅ 修改 / 附加到這份」。每一份獨立決定，不會一鍵全蓋。',
        wrap: true,
        size: 'Small',
        spacing: 'Medium',
        color: 'Light',
      },

      sectionHeader('**💬 直接用自然語言（不用 #）**'),
      bullet('• 「明天要完成什麼」→ 查待辦'),
      bullet('• 「我之前記了客戶 A 什麼」→ 搜筆記'),
      bullet('• 「運費怎麼算」→ 查公司知識庫'),
      bullet('• 「明天下午兩點提醒我開會」→ 新增提醒'),
      {
        type: 'TextBlock',
        text: '─────────────────────',
        color: 'Light',
        size: 'Small',
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text: '💡 每天早上 9:00 會自動提醒你未完成的待辦事項',
        wrap: true,
        size: 'Small',
        color: 'Light',
      },
    ],
  };
}

/**
 * 提醒完成確認
 */
export function createReminderCompletedCard(reminder: Reminder): object {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: '✅ 已完成',
        weight: 'Bolder',
        color: 'Good',
      },
      {
        type: 'TextBlock',
        text: `~~${reminder.content}~~`,
        wrap: true,
      },
    ],
  };
}

/**
 * 圖片附加完成卡片
 */
export function createImageAttachedCard(
  targetType: 'note' | 'reminder',
  targetId: number,
  targetContent: string,
  uploaded: BlobImage[],
  totalCount: number,
  errors: string[],
): object {
  const label = targetType === 'note' ? '筆記' : '提醒';
  const preview = targetContent.length > 40 ? targetContent.slice(0, 40) + '...' : targetContent;

  const body: any[] = [
    {
      type: 'TextBlock',
      text: `📸 已附加 ${uploaded.length} 張圖到${label} #${targetId}`,
      weight: 'Bolder',
      color: 'Good',
    },
    {
      type: 'TextBlock',
      text: preview,
      wrap: true,
      size: 'Small',
      color: 'Light',
      spacing: 'None',
    },
    ...imageRow(uploaded, 5),
    {
      type: 'TextBlock',
      text: `目前這則${label}共有 ${totalCount} 張圖`,
      size: 'Small',
      color: 'Light',
      spacing: 'Small',
    },
  ];

  if (errors.length > 0) {
    body.push({
      type: 'TextBlock',
      text: `⚠️ 有 ${errors.length} 張圖上傳失敗：${errors.join('；')}`,
      wrap: true,
      size: 'Small',
      color: 'Warning',
      spacing: 'Small',
    });
  }

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
  };
}

// ── 工具函式 ──

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
