/**
 * Application Insights 遙測包裝層
 *
 * 設計原則：
 * - 沒設 APPLICATIONINSIGHTS_CONNECTION_STRING 時自動降級為 no-op，本地開發不報錯
 * - 對外只提供 trackEvent / trackException 兩個簡單 API，不讓業務邏輯碰 SDK 細節
 * - Auto-collection（HTTP 請求、依賴、exception）交給 SDK 預設行為，不額外設定
 */

import * as appInsights from 'applicationinsights';

let client: appInsights.TelemetryClient | null = null;

export function initTelemetry(): void {
  const connStr = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connStr) {
    console.log('[Telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING 未設定，遙測停用');
    return;
  }

  try {
    appInsights
      .setup(connStr)
      .setAutoCollectRequests(true)             // HTTP 請求
      .setAutoCollectDependencies(true)         // 外呼 API (Azure OpenAI, Notion, Google, Wiki.js)
      .setAutoCollectExceptions(true)           // 未捕捉例外
      .setAutoCollectPerformance(true, false)   // CPU/記憶體等基本 perf counter（不收 extended metrics）
      .setAutoCollectConsole(false)             // Console log 不送（量太大）
      .setSendLiveMetrics(true)                 // Live Metrics stream
      .setDistributedTracingMode(appInsights.DistributedTracingModes.AI_AND_W3C)
      .start();

    client = appInsights.defaultClient;
    client.context.tags[client.context.keys.cloudRole] = 'support-knowledge-bot';
    console.log('[Telemetry] Application Insights 初始化完成');
  } catch (err: any) {
    console.error('[Telemetry] 初始化失敗:', err.message);
  }
}

/**
 * 送一個自訂事件（會出現在 App Insights Logs 的 `customEvents` 表）
 * properties 是 key-value dimensions，用來做 group by / filter
 * measurements 是數值型（例如 responseTime、tokenCount）
 */
export function trackEvent(
  name: string,
  properties?: Record<string, string | number | boolean | undefined>,
  measurements?: Record<string, number>,
): void {
  if (!client) return;
  try {
    // 把 undefined / 數字 / 布林轉成字串（App Insights properties 只收 string）
    const stringProps: Record<string, string> = {};
    if (properties) {
      for (const [k, v] of Object.entries(properties)) {
        if (v === undefined || v === null) continue;
        stringProps[k] = typeof v === 'string' ? v : String(v);
      }
    }
    client.trackEvent({ name, properties: stringProps, measurements });
  } catch (err: any) {
    console.error(`[Telemetry] trackEvent(${name}) 失敗:`, err.message);
  }
}

/**
 * 送一個例外事件（會出現在 `exceptions` 表）
 */
export function trackException(
  error: Error,
  properties?: Record<string, string | undefined>,
): void {
  if (!client) return;
  try {
    const stringProps: Record<string, string> = {};
    if (properties) {
      for (const [k, v] of Object.entries(properties)) {
        if (v !== undefined && v !== null) stringProps[k] = v;
      }
    }
    client.trackException({ exception: error, properties: stringProps });
  } catch (err: any) {
    console.error('[Telemetry] trackException 失敗:', err.message);
  }
}
