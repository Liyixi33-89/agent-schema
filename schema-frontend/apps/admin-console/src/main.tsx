/**
 * M11 管理端入口（应用壳：认证会话 + 导航壳 + 页面装配）。
 * 业务页面按 feature 内聚（features/<业务>/），入口只做组合根——不承载业务请求与转换。
 * 请求层收敛至 api.ts（复用 auth-sdk；安全边界不动：主站/验收隔离、Cookie/Bearer 通道隔离）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Card, ConfigProvider, Form, Input, Layout, Tabs, Typography, Space, message } from 'antd';
import {
  broadcastLogout, initCsrf, login as sdkLogin, logout as sdkLogout, watchAuthChannel,
} from '@schema/auth-sdk';
import { errOf, setSessionExpiredHandler } from './api';
import { UsagePage } from './features/usage';
import { MembersPage } from './features/members';
import { NoticesPage } from './features/notices';
import HealthPage from './features/ops-health/HealthPage';
import SlaPage from './features/ops-health/SlaPage';

interface SessionState { account: string }

const BASE = import.meta.env.VITE_API_BASE ?? '';

// ---------- 登录 ----------

function LoginPanel({ onLogin }: { onLogin: (account: string) => void }): React.ReactElement {
  const [form] = Form.useForm();
  React.useEffect(() => { void initCsrf(BASE); }, []);   // 匿名 csrf（登录 CSRF 防护）
  return (
    <Card title="Schema 管理端 · 登录" style={{ maxWidth: 380, margin: '80px auto' }}>
      <Form form={form} onFinish={async (v: { account: string; password: string }) => {
        try {
          await sdkLogin(BASE, v);
          sessionStorage.setItem('schema_session', '1');
          localStorage.setItem('schema_account', v.account);
          localStorage.setItem('schema_tenant', localStorage.getItem('schema_tenant') ?? '1');
          onLogin(v.account);
        } catch (e) {
          message.error(errOf(e));
        }
      }}>
        <Form.Item name="account" rules={[{ required: true, message: '请输入账号' }]}>
          <Input placeholder="管理员账号" />
        </Form.Item>
        <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="密码" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block>登录</Button>
      </Form>
    </Card>
  );
}

// ---------- 入口 ----------

function App(): React.ReactElement {
  const [session, setSession] = React.useState<SessionState | null>(() =>
    sessionStorage.getItem('schema_session') === '1'
      ? { account: localStorage.getItem('schema_account') ?? '' }
      : null,
  );
  React.useEffect(() => { document.title = 'Schema 管理端'; }, []);
  React.useEffect(() => { watchAuthChannel((msg) => {
    if (msg.type === 'logout') {
      sessionStorage.removeItem('schema_session');
      setSession(null);
    }
  }), []; });
  // 401 静默刷新失败 → 回登录页（authFetch 回调注入）
  React.useEffect(() => {
    setSessionExpiredHandler(() => {
      sessionStorage.removeItem('schema_session');
      setSession(null);
    });
    return () => { setSessionExpiredHandler(null); };
  }, []);

  if (!session) {
    return (
      <ConfigProvider>
        <LoginPanel onLogin={(account) => setSession({ account })} />
      </ConfigProvider>
    );
  }
  return (
    <ConfigProvider>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography.Text style={{ color: '#fff', fontSize: 16 }}>Schema · 平台管理端</Typography.Text>
          <Space>
            <Typography.Text style={{ color: '#ccc' }}>{session.account}</Typography.Text>
            <Button size="small" onClick={() => {
              void sdkLogout(BASE).then((result) => {
                if (!result.revoked) {
                  // 服务端撤销失败：本地已清屏但 HttpOnly 会话可能仍有效——明确提示
                  message.warning(`登出未完成：${result.message ?? '服务端撤销失败'}，请关闭浏览器或稍后重试`);
                }
                broadcastLogout(BASE);
                sessionStorage.removeItem('schema_session');
                setSession(null);
              });
            }}>退出</Button>
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: 24, maxWidth: 1080, margin: '0 auto', width: '100%' }}>
          <Card>
            <Tabs
              items={[
                { key: 'usage', label: '租户用量', children: <UsagePage /> },
                { key: 'members', label: '成员管理', children: <MembersPage /> },
                { key: 'health', label: '健康状态', children: <HealthPage /> },
                { key: 'sla', label: 'SLA 看板', children: <SlaPage /> },
                { key: 'notices', label: '维护公告', children: <NoticesPage /> },
              ]}
            />
          </Card>
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);