/**
 * Schema ETag 缓存层（渐进重构第四批——自 main.tsx 原样抽出，行为不变）：
 * localStorage 按租户键隔离——页面加载 304 命中免拉全量。
 */

/** Schema ETag 缓存读取（页面加载 304 命中——localStorage 按租户键隔离）。 */
export function cachedEntry(pageId: string): { etag: string | null; schema: unknown } {
  const tenant = localStorage.getItem('schema_tenant') ?? 'default';
  const raw = localStorage.getItem(`schema_page_cache_${tenant}_${pageId}`);
  if (!raw) return { etag: null, schema: null };
  try {
    const parsed = JSON.parse(raw) as { etag: string; schema: unknown };
    return { etag: parsed.etag, schema: parsed.schema };
  } catch {
    return { etag: null, schema: null };
  }
}

export function cacheEntry(pageId: string, etag: string | null, schema: unknown): void {
  const tenant = localStorage.getItem('schema_tenant') ?? 'default';
  const key = `schema_page_cache_${tenant}_${pageId}`;
  if (etag && schema != null) localStorage.setItem(key, JSON.stringify({ etag, schema }));
  else localStorage.removeItem(key);
}
