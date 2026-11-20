/**
 * M11 设计器工作台入口（13BE §A.1/§A.2）：
 * - 登录态：v0.4 HttpOnly Cookie 三件套（前端零凭证存储——本地仅存展示用账号名）
 * - 编排：卡片墙（Workspace）↔ 应用设置六页签（AppSettings）
 *
 * 渐进重构第三批：登录拆至 LoginPanel、会话态/标签/错误提示拆至 shellShared、
 * 卡片墙拆至 Workspace、六页签编排拆至 AppSettings（成员/导航/主题/发布各自独立成页）——
 * 本文件收敛为登录判定 + 壳层编排，行为不变。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button, ConfigProvider, Layout, Space, Typography } from 'antd';
import type { AppCard } from '../shared/api';
import { useSession } from './shellShared';
import LoginPanel from './LoginPanel';
import { Workspace } from '../features/workspace';
import AppSettings from './AppSettings';

function App(): React.ReactElement {
  const [session, logout] = useSession();
  const [activeApp, setActiveApp] = React.useState<AppCard | null>(null);

  React.useEffect(() => {
    document.title = 'Schema 设计器';
  }, []);

  if (!session) {
    return (
      <ConfigProvider>
        <LoginPanel onLogin={(account) => {
          localStorage.setItem('schema_account', account);
          window.location.reload();
        }} />
      </ConfigProvider>
    );
  }
  return (
    <ConfigProvider>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography.Text style={{ color: '#fff', fontSize: 16 }}>Schema · 设计器工作台</Typography.Text>
          <Space>
            <Typography.Text style={{ color: '#ccc' }}>{session.account}</Typography.Text>
            <Button size="small" onClick={logout}>退出</Button>
          </Space>
        </Layout.Header>
        {activeApp
          ? <AppSettings app={activeApp} onBack={() => setActiveApp(null)} />
          : <Workspace onOpenSettings={setActiveApp} />}
      </Layout>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
