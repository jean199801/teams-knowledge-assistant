import sql from 'mssql';
import { config } from '../config';

let pool: sql.ConnectionPool | null = null;

export async function getKmDb(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;

  if (config.kmDb.authType === 'azure-ad') {
    // Azure AD Default 認證（使用 az login 的身份）
    console.log('[DB] 使用 Azure AD Default 認證...');
    pool = await sql.connect({
      server: config.kmDb.server,
      database: config.kmDb.database,
      authentication: {
        type: 'azure-active-directory-default',
      },
      options: config.kmDb.options,
    } as any);
  } else {
    // 傳統 SQL 帳號密碼認證
    pool = await sql.connect({
      server: config.kmDb.server,
      database: config.kmDb.database,
      user: config.kmDb.user,
      password: config.kmDb.password,
      options: config.kmDb.options,
    });
  }

  return pool;
}

export async function closeKmDb(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
