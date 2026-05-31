import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface EditDocResult {
  sourceId: string;
  sourceType: string;
  title: string;
  action: 'approved' | 'skipped';
  editResult?: { success: boolean; error?: string };
}

export interface EditLogEntry {
  id: number;
  userId: string;
  userName: string;
  oldText: string;
  newText: string;
  documents: EditDocResult[];
  createdAt: string;
}

interface EditLog {
  entries: EditLogEntry[];
  nextId: number;
}

function getLogPath(): string {
  return path.join(config.dataDir, 'edit-logs.json');
}

function loadLog(): EditLog {
  const fp = getLogPath();
  if (fs.existsSync(fp)) {
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {
      // corrupt file
    }
  }
  return { entries: [], nextId: 1 };
}

function saveLog(log: EditLog): void {
  const dir = path.dirname(getLogPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getLogPath(), JSON.stringify(log, null, 2), 'utf-8');
}

/**
 * 儲存一筆修改紀錄
 */
export function addEditLog(
  userId: string,
  userName: string,
  oldText: string,
  newText: string,
  documents: EditDocResult[],
): EditLogEntry {
  const log = loadLog();
  const entry: EditLogEntry = {
    id: log.nextId,
    userId,
    userName,
    oldText,
    newText,
    documents,
    createdAt: new Date().toISOString(),
  };
  log.entries.push(entry);
  log.nextId++;

  // 只保留最近 500 筆
  if (log.entries.length > 500) {
    log.entries = log.entries.slice(-500);
  }

  saveLog(log);
  return entry;
}

/**
 * 取得最近的修改紀錄
 */
export function getEditLogs(limit = 20): EditLogEntry[] {
  const log = loadLog();
  return log.entries.slice(-limit).reverse();
}
