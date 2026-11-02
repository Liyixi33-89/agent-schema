/**
 * M11 运行时容器入口：
 * - #/app/:appId                → 应用导航壳（过滤菜单 + 页面路由）
 * - #/app/:appId/page/:pageId   → 壳内页面（导航壳选中态）
 * - #/page/:pageId[/:recordId]  → 裸页面（预览凭证通道，保持隔离）
 * 装载：发布 PageSchema + 字段元数据 → FormPageHost 装配；Schema ETag 缓存（localStorage，按租户失效）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Typography } from 'antd';
import { RequestClient } from './request';
import { UsageTracker } from '@schema/usage-tracker';
import FormPageHost from './FormPageHost';
import { AppShell, watchTenantChange } from './AppShell';

// v0.4 Cookie 通道：正式访问不带 getToken（schema_at 自动携带）；预览页场景由宿主另行注入 Bearer
const client = new RequestClient({
  baseUrl: import.meta.env.VITE_API_BASE ?? '',
  getTenantId: () => localStorage.getItem('schema_tenant'),
  // 401 静默刷新失败（REFRESH_REVOKED）：清本地页面缓存跳登录提示（运行时无登录页——提示后由
  // 宿主/用户重新进入；缓存清除防下一会话读到跨会话 schema）
  onSessionExpired: () => {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith('schema_page_cache_')) localStorage.removeItem(key);
    }
    location.reload();
  },
});

/** 计量埋点（09FE）：认证头与请求层同通道（Cookie + 双提交）——上报通道需登录态。 */
const tracker = new UsageTracker({
  authHeader: () => client.authHeaders(),
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') tracker.onVisibilityHidden();
});

interface RouteInfo {
  kind: 'app' | 'page';
  appId?: string;
  pageId?: string;
  recordId?: string;
}

function parseHash(): RouteInfo | null {
  const appMatch = location.hash.match(/^#\/app\/(\d+)(?:\/page\/(\d+))?/);
  if (appMatch) {
    return appMatch[2]
      ? { kind: 'app', appId: appMatch[1], pageId: appMatch[2] }
      : { kind: 'app', appId: appMatch[1] };
  }
  const m = location.hash.match(/^#\/page\/(\d+)(?:\/(\d+))?/);
  if (!m) return null;
  return { kind: 'page', pageId: m[1], recordId: m[2] };
}

/** Schema ETag 缓存读取（页面加载 304 命中——localStorage 按租户键隔离）。 */
function cachedEntry(pageId: string): { etag: string | null; schema: unknown } {
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

function cacheEntry(pageId: string, etag: string | null, schema: unknown): void {
  const tenant = localStorage.getItem('schema_tenant') ?? 'default';
  const key = `schema_page_cache_${tenant}_${pageId}`;
  if (etag && schema != null) localStorage.setItem(key, JSON.stringify({ etag, schema }));
  else localStorage.removeItem(key);
}

function App(): React.ReactElement {
  const [route, setRoute] = React.useState<RouteInfo | null>(parseHash());
  React.useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    // 租户切换清缓存 + 强制重载路由态
    const stop = watchTenantChange(() => {
      setRoute(parseHash());
    });
    return () => {
      window.removeEventListener('hashchange', onHash);
      stop();
    };
  }, []);

  const pageHost = (pageId: string, recordId?: string): React.ReactElement => {
    const cached = cachedEntry(pageId);
    return (
      <FormPageHost
        client={client}
        pageId={pageId}
        recordId={recordId}
        etag={cached.etag}
        cachedSchema={cached.schema}
        onEtag={(etag, schema) => {
          // 304 命中 schema=null：缓存仍有效不覆写；200 全新内容则持久化
          if (schema != null) cacheEntry(pageId, etag, schema);
        }}
        onSubmitted={() => { window.location.reload(); }}
      />
    );
  };

  if (!route) {
    return (
      <Typography.Paragraph style={{ padding: 24 }}>
        运行时容器就绪。访问 {'#/app/:appId'} 打开应用导航壳；{'#/page/:pageId'} 直接打开发布页面（预览通道）。
      </Typography.Paragraph>
    );
  }
  if (route.kind === 'app' && route.appId) {
    return (
      <AppShell
        client={client}
        appId={route.appId}
        onPageSelect={(pageId) => { location.hash = `#/app/${route.appId}/page/${pageId}`; }}
      >
        {route.pageId
          ? pageHost(route.pageId)
          : <Typography.Paragraph type="secondary">从左侧菜单选择页面</Typography.Paragraph>}
      </AppShell>
    );
  }
  return pageHost(route.pageId!, route.recordId);
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);