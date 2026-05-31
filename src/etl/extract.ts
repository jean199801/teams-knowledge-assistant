import { getKmDb } from '../utils/sql-server';
import { config } from '../config';

export interface PageRecord {
  id: number;
  path: string;
  title: string;
  description: string;
  content: string;
  render: string;
  contentType: string;
  toc: string;
  updatedAt: Date;
  authorId: number;
}

/**
 * Extract published, non-private knowledge pages from Wiki.js [dbo].[pages].
 * When config.etl.categories is empty, all published & public pages are returned.
 */
export async function extractPages(
  lastSyncTime?: Date,
): Promise<PageRecord[]> {
  const db = await getKmDb();

  let query = `
    SELECT
      p.id,
      p.path,
      p.title,
      p.description,
      p.content,
      p.render,
      p.contentType,
      p.toc,
      p.updatedAt,
      p.authorId
    FROM [dbo].[pages] p
    WHERE p.isPublished = 1
      AND p.isPrivate = 0
  `;

  // 如果有指定分類就篩選，否則抓全部
  if (config.etl.categories.length > 0) {
    const categoryConditions = config.etl.categories
      .map((cat, i) => `p.path LIKE @cat${i}`)
      .join(' OR ');
    query += `      AND (${categoryConditions})\n`;
  }

  if (lastSyncTime) {
    query += `      AND p.updatedAt > @lastSyncTime`;
  }

  query += `\n    ORDER BY p.updatedAt DESC`;

  const request = db.request();
  config.etl.categories.forEach((cat, i) => {
    request.input(`cat${i}`, `${cat}/%`);
  });
  if (lastSyncTime) {
    request.input('lastSyncTime', lastSyncTime);
  }

  const result = await request.query<PageRecord>(query);
  console.log(
    `[Extract] 抽取到 ${result.recordset.length} 篇文件` +
      (lastSyncTime ? `（上次同步: ${lastSyncTime.toISOString()}）` : '（全量同步）'),
  );

  return result.recordset;
}
