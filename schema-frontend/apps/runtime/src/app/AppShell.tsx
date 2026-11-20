/**
 * M11 运行时导航壳（13BE §3.3）：应用菜单 + 页面路由 + 鉴权守卫。
 * 路由：#/app/:appId（导航壳）/ #/app/:appId/page/:pageId（页面）。
 * 菜单可见性 = 服务端过滤树（GET /api/apps/{id}/nav?filtered=true）——前端不做权限二次判断。
 * 租户切换清缓存：schema_tenant 变更时 localStorage ETag 缓存全清。
 */
import React from 'react';
import { Menu, Typography } from 'antd';
import { RequestClient } from '../shared/request';
import type { MenuProps } from 'antd';
import { AppThemeProvider } from './AppThemeProvider';

export interface NavNode {
  id: string;
  type: 'PAGE' | 'GROUP' | 'LINK';
  label: string;
  refId?: number;
  url?: string;
  children?: NavNode[];
}

export interface AppShellInfo {
  appId: string;
  name: string;
  nav: NavNode[];
}

/** 导航树 → antd Menu items（GROUP → submenu；PAGE → 路由跳转；LINK → 外链）。 */
function toMenuItems(nav: NavNode[], appId: string, onPage: (pageId: string) => void): MenuProps['items'] {
  return nav.map((n) => {
    if (n.type === 'GROUP') {
      return {
        key: n.id,
        label: n.label,
        children: toMenuItems(n.children ?? [], appId, onPage),
      };
    }
    if (n.type === 'LINK') {
      return { key: `link:${n.id}`, label: <a href={n.url} target="_blank" rel="noreferrer">{n.label}</a> };
    }
    return { key: `page:${n.refId}`, label: n.label, onClick: () => onPage(String(n.refId)) };
  });
}

export function AppShell({ client, appId, children, onPageSelect }: {
  client: RequestClient;
  appId: string;
  children: React.ReactNode;
  onPageSelect: (pageId: string) => void;
}): React.ReactElement {
  const [nav, setNav] = React.useState<NavNode[] | null>(null);
  /** nav 装载响应附带的应用主题（spec 019：运行时主题装载通道）。 */
  const [navTheme, setNavTheme] = React.useState<unknown>(null);
  const [error, setError] = React.useState<string | null>(null);
  /** 应用切换装载隔离（spec 019 §8）：装载结果按 appId 绑定，防旧应用导航/主题串显。 */
  const [loadedFor, setLoadedFor] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setNav(null);
    setNavTheme(null);
    setError(null);
    setLoadedFor(null);
    (async () => {
      try {
        // 导航壳与数据面同走统一通道（authFetch：401 静默刷新 + 403 csrf 重试——不裸 fetch）
        const resp = await client.get(`/api/apps/${appId}/nav?filtered=true`);
        if (resp.status === 401) throw new Error('登录已过期，请重新登录');
        if (resp.status === 404) throw new Error('应用不存在或未发布');
        if (!resp.ok) throw new Error(`导航加载失败 (${resp.status})`);
        const body = (await resp.json()) as { tree: NavNode[]; theme?: unknown };
        if (!cancelled) {
          setNav(body.tree ?? []);
          setNavTheme(body.theme ?? null);
          setLoadedFor(appId);   // 装载结果仅对当前 appId 生效（竞态丢弃旧应用响应）
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [client, appId, reload]);

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <Typography.Paragraph type="danger">{error}</Typography.Paragraph>
        <Typography.Paragraph>
          <a onClick={() => setReload((v) => v + 1)}>重试加载</a>
        </Typography.Paragraph>
      </div>
    );
  }
  if (loadedFor !== appId || nav === null) {
    return <Typography.Paragraph style={{ padding: 24 }}>加载导航…</Typography.Paragraph>;
  }
  const items = toMenuItems(nav, appId, onPageSelect);
  if (!items?.length) {
    return (
      <AppThemeProvider navTheme={navTheme}>
        <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--schema-bg)', color: 'var(--schema-fg)' }}>
          <aside style={{ width: 220, borderRight: '1px solid var(--schema-border)', padding: 16 }}>
            <Typography.Text type="secondary">无可访问菜单</Typography.Text>
          </aside>
          <main style={{ flex: 1, padding: 24 }}>{children}</main>
        </div>
      </AppThemeProvider>
    );
  }
  return (
    <AppThemeProvider navTheme={navTheme}>
      {/* 壳层背景跟随主题（原生 div 不走 antd Layout——CSS 变量驱动暗色） */}
      <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--schema-bg)', color: 'var(--schema-fg)', fontFamily: 'var(--schema-font)', transition: 'background 0.2s' }}>
        <aside style={{ width: 220, borderRight: '1px solid var(--schema-border)', background: 'var(--schema-bg-layout)' }}>
          <Menu mode="inline" style={{ borderInlineEnd: 'none', background: 'transparent' }} items={items} />
        </aside>
        <main style={{ flex: 1, padding: 24, minWidth: 0 }}>{children}</main>
      </div>
    </AppThemeProvider>
  );
}

/** 租户切换缓存清理（spec：schema_tenant 变更即失效全部 ETag 缓存）。 */
export function watchTenantChange(onChange: () => void): () => void {
  let last = localStorage.getItem('schema_tenant');
  const timer = window.setInterval(() => {
    const cur = localStorage.getItem('schema_tenant');
    if (cur !== last) {
      last = cur;
      // 租户切换：清全部页面级 Schema/ETag 缓存（隔离边界）
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith('schema_page_cache_')) localStorage.removeItem(key);
      }
      onChange();
    }
  }, 1000);
  return () => window.clearInterval(timer);
}