/**
 * M11 运行时容器入口（渐进重构第四批收敛为路由编排壳——行为不变）：
 * - #/app/:appId                → 应用导航壳（过滤菜单 + 页面路由）
 * - #/app/:appId/page/:pageId   → 壳内页面（导航壳选中态）
 * - #/page/:pageId[/:recordId]  → 裸页面（预览凭证通道，保持隔离）
 * - #/preview?grant=xxx         → 预览凭证兑换（拆至 PreviewPage）
 * 装载：发布 PageSchema + 字段元数据 → FormPageHost 装配；Schema ETag 缓存（拆至 pageCache）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Typography } from 'antd';
import { RequestClient } from '../shared/request';
import { UsageTracker } from '@schema/usage-tracker';
import FormPageHost from '../features/page-host/FormPageHost';
import { AppShell, watchTenantChange } from './AppShell';
import SessionExpired from './SessionExpired';
import PreviewPage from '../features/preview/PreviewPage';
import { cachedEntry, cacheEntry } from './pageCache';
import { parseRuntimeHash, type RouteInfo } from './route';

// v0.4 Cookie 通道：正式访问不带 getToken（schema_at 自动携带）；预览页场景由宿主另行注入 Bearer
/** 会话失效信号桥（模块级——client 回调触发 React 状态切占位组件；App 挂载时接管）。 */
let notifySessionExpired: (() => void) | null = null;
const client = new RequestClient({
  baseUrl: import.meta.env.VITE_API_BASE ?? '',
  getTenantId: () => localStorage.getItem('schema_tenant'),
  // 401 静默刷新失败（REFRESH_REVOKED）：置会话失效态渲染占位组件（2026-11-03 收口——
  // 不再 location.reload：停止加载业务、不反复重载、清权限快照与 Schema 缓存防旧数据/跨会话残留）
  onSessionExpired: () => { notifySessionExpired?.(); },
});

/** 计量埋点（09FE）：认证头与请求层同通道（Cookie + 双提交）——上报通道需登录态。 */
const tracker = new UsageTracker({
  authHeader: () => client.authHeaders(),
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') tracker.onVisibilityHidden();
});

function parseHash(): RouteInfo | null {
  return parseRuntimeHash(location.hash);
}

function App(): React.ReactElement {
  const [route, setRoute] = React.useState<RouteInfo | null>(parseHash());
  const [sessionExpired, setExpired] = React.useState(false);
  React.useEffect(() => {
    notifySessionExpired = () => setExpired(true);
    return () => { notifySessionExpired = null; };
  }, []);
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

  // 会话失效：占位组件接管整页（业务组件卸载——停止加载、不重载、不残留旧数据）
  if (sessionExpired) {
    return <SessionExpired />;
  }

  // ETag 缓存条目引用稳定化（M16 修复）：hash 导航触发 App 重渲染时
  // cachedEntry 每次返回新对象 → FormPageHost 外层装载 effect 依赖 cachedSchema
  // 引用变化多余重跑 → SchemaFormPage 卸载重挂 → 编辑态详情回填竞态丢失。
  // 按 pageId 记忆化：同 pageId 渲染间保持同一引用，effect 不再重跑。
  const cacheRef = React.useRef(new Map<string, { etag: string | null; schema: unknown }>());

  const pageHost = (pageId: string, recordId?: string): React.ReactElement => {
    let cached = cacheRef.current.get(pageId);
    if (!cached) {
      cached = cachedEntry(pageId);
      cacheRef.current.set(pageId, cached);
    }
    return (
      <FormPageHost
        client={client}
        pageId={pageId}
        recordId={recordId}
        etag={cached.etag}
        cachedSchema={cached.schema}
        onEtag={(etag, schema) => {
          // 304 命中 schema=null：缓存仍有效不覆写；200 全新内容则持久化
          if (schema != null) {
            cacheEntry(pageId, etag, schema);
            cacheRef.current.set(pageId, { etag, schema });
          }
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
          ? pageHost(route.pageId, route.recordId)
          : <Typography.Paragraph type="secondary">从左侧菜单选择页面</Typography.Paragraph>}
      </AppShell>
    );
  }
  if (route.kind === 'preview' && route.grantId) {
    return <PreviewPage grantId={route.grantId} />;
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
