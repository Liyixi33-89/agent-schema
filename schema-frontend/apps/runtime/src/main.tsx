/**
 * M11 运行时容器最小入口（2026-10-30）：
 * 路由：#/page/:pageId 与 #/page/:pageId/:recordId（编辑态）。
 * 装载：发布 PageSchema + 字段元数据 → FormPageHost 装配。
 * 错误态/加载态展示；认证头从 localStorage 注入（预览 token 同通道）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Typography } from 'antd';
import { RequestClient } from './request';
import { UsageTracker } from '@schema/usage-tracker';
import FormPageHost from './FormPageHost';

const client = new RequestClient({
  baseUrl: import.meta.env.VITE_API_BASE ?? '',
  getToken: () => localStorage.getItem('schema_token'),
  getTenantId: () => localStorage.getItem('schema_tenant'),
});

/** 计量埋点（09FE）：认证头与请求层同通道（schema_token）——上报通道需登录态。 */
const tracker = new UsageTracker({
  authHeader: () => {
    const token = localStorage.getItem('schema_token');
    const tenant = localStorage.getItem('schema_tenant');
    const h: Record<string, string> = {};
    if (token) h.Authorization = `Bearer ${token}`;
    if (tenant) h['X-Tenant-Id'] = tenant;
    return h;
  },
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') tracker.onVisibilityHidden();
});

interface RouteInfo { pageId: string; recordId?: string }

function parseHash(): RouteInfo | null {
  const m = location.hash.match(/^#\/page\/(\d+)(?:\/(\d+))?/);
  if (!m) return null;
  return { pageId: m[1], recordId: m[2] };
}

function App(): React.ReactElement {
  const [route, setRoute] = React.useState<RouteInfo | null>(parseHash());
  React.useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!route) {
    return (
      <Typography.Paragraph style={{ padding: 24 }}>
        运行时容器就绪。访问 {'#/page/:pageId'} 打开发布页面；编辑态 {'#/page/:pageId/:recordId'}。
      </Typography.Paragraph>
    );
  }
  return (
    <FormPageHost
      client={client}
      pageId={route.pageId}
      recordId={route.recordId}
      onSubmitted={() => { window.location.reload(); }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
