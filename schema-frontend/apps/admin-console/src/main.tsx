/**
 * M11 管理端 P1（console-p1 验收）：租户用量 / 成员管理 / 健康状态 / 维护公告。
 * 数据源：/api/metering/usage/summary（09BE）、/api/org/members（03BE）、
 * /api/ops/health 与 /api/ops/notices（13BE §6 分期最小集）。
 * v0.4：HttpOnly Cookie 通道（schema_at 自动携带 + X-CSRF-Token 双提交）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert, Button, Card, ConfigProvider, Form, Input, Layout, List, message, Space, Statistic,
  Table, Tabs, Tag, Typography,
} from 'antd';
import {
  authFetch, broadcastLogout, initCsrf, login as sdkLogin, logout as sdkLogout, watchAuthChannel,
} from '@schema/auth-sdk';

interface SessionState { account: string }

const BASE = import.meta.env.VITE_API_BASE ?? '';

/** 401 静默刷新失败回调（清本地态回登录页）。 */
let onSessionExpired: (() => void) | null = null;

async function req(method: string, path: string, body?: unknown): Promise<unknown> {
  const resp = await authFetch({
    path,
    baseUrl: BASE,
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    onSessionExpired: () => onSessionExpired?.(),
  });
  if (resp.status === 401) throw new Error('登录已过期，请重新登录');
  if (!resp.ok) {
    const raw = await resp.json().catch(() => ({}));
    throw new Error((raw as { message?: string }).message ?? `请求失败 (${resp.status})`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

function errOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

// ---------- 租户用量 ----------

interface UsageSummary {
  licensedSeats?: number;
  activeSeats?: number;
  metrics?: { metric: string; today?: number; total?: number }[];
}

function UsageTab(): React.ReactElement {
  const [data, setData] = React.useState<UsageSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    req('GET', '/api/metering/usage/summary')
      .then((r) => setData(r as UsageSummary))
      .catch((e) => setError(errOf(e)));
  }, []);
  if (error) return <Alert type="error" showIcon message="用量加载失败" description={error} />;
  if (!data) return <Typography.Paragraph>加载中…</Typography.Paragraph>;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Space size="large">
        <Card><Statistic title="授权席位（设计能力口径）" value={data.licensedSeats ?? 0} /></Card>
        <Card><Statistic title="活跃席位（30 天窗口）" value={data.activeSeats ?? 0} /></Card>
      </Space>
      <Table
        rowKey="metric"
        dataSource={data.metrics ?? []}
        columns={[
          { title: '指标', dataIndex: 'metric', key: 'metric' },
          { title: '今日', dataIndex: 'today', key: 'today' },
          { title: '累计', dataIndex: 'total', key: 'total' },
        ]}
        pagination={false}
      />
    </Space>
  );
}

// ---------- 成员管理 ----------

interface MemberItem { id: number; account: string; name?: string; status: string }

function MembersTab(): React.ReactElement {
  const [list, setList] = React.useState<MemberItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [form] = Form.useForm();
  const load = React.useCallback(() => {
    req('GET', '/api/org/members')
      .then((r) => setList(((r as { list?: MemberItem[] }).list ?? []) as MemberItem[]))
      .catch((e) => setError(errOf(e)));
  }, []);
  React.useEffect(() => { load(); }, [load]);

  if (error) return <Alert type="error" showIcon message="成员加载失败" description={error} />;
  return (
    <>
      <Card size="small" style={{ marginBottom: 12 }} title="新建成员">
        <Form form={form} layout="inline" onFinish={async (v: { account: string; name: string }) => {
          try {
            await req('POST', '/api/org/members', v);
            message.success('成员已创建（初始密码仅返回一次）');
            form.resetFields();
            load();
          } catch (e) { message.error(errOf(e)); }
        }}>
          <Form.Item name="account" rules={[{ required: true }]}><Input placeholder="账号" /></Form.Item>
          <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="姓名" /></Form.Item>
          <Button type="primary" htmlType="submit">创建</Button>
        </Form>
      </Card>
      <Table
        rowKey="id"
        loading={list === null}
        dataSource={list ?? []}
        columns={[
          { title: 'ID', dataIndex: 'id', key: 'id', width: 80 },
          { title: '账号', dataIndex: 'account', key: 'account' },
          { title: '姓名', dataIndex: 'name', key: 'name' },
          {
            title: '状态', dataIndex: 'status', key: 'status',
            render: (s: string) => s === 'ACTIVE' ? <Tag color="green">正常</Tag> : <Tag color="red">停用</Tag>,
          },
        ]}
        pagination={{ pageSize: 10 }}
      />
    </>
  );
}

// ---------- 健康状态 ----------

interface HealthInfo { status: string; db: string; version: string; timestamp: string }

function HealthTab(): React.ReactElement {
  const [data, setData] = React.useState<HealthInfo | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    req('GET', '/api/ops/health')
      .then((r) => setData(r as HealthInfo))
      .catch((e) => setError(errOf(e)));
  }, []);
  React.useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  if (error) return <Alert type="error" showIcon message="健康检查失败" description={error} />;
  if (!data) return <Typography.Paragraph>检查中…</Typography.Paragraph>;
  return (
    <Space direction="vertical">
      <Space size="large">
        <Card>
          <Statistic
            title="平台状态"
            value={data.status}
            valueStyle={{ color: data.status === 'UP' ? '#3f8600' : '#cf1322' }}
          />
        </Card>
        <Card><Statistic title="数据库" value={data.db} valueStyle={{ color: data.db === 'UP' ? '#3f8600' : '#cf1322' }} /></Card>
        <Card><Statistic title="版本" value={data.version} /></Card>
      </Space>
      <Typography.Text type="secondary">检查时间：{data.timestamp}（15 秒自动刷新）</Typography.Text>
    </Space>
  );
}

// ---------- 维护公告 ----------

interface NoticeItem {
  id: number; title: string; content: string; level: string; active: boolean; updated_at?: string;
}

function NoticesTab(): React.ReactElement {
  const [list, setList] = React.useState<NoticeItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [form] = Form.useForm();
  const load = React.useCallback(() => {
    req('GET', '/api/ops/notices')
      .then((r) => setList(((r as { list?: NoticeItem[] }).list ?? []) as NoticeItem[]))
      .catch((e) => setError(errOf(e)));
  }, []);
  React.useEffect(() => { load(); }, [load]);

  if (error) return <Alert type="error" showIcon message="公告加载失败" description={error} />;
  return (
    <>
      <Card size="small" style={{ marginBottom: 12 }} title="发布维护公告（发布即生效，撤销旧公告）">
        <Form form={form} layout="vertical" style={{ maxWidth: 520 }} onFinish={async (v: {
          title: string; content: string; level: string;
        }) => {
          try {
            await req('POST', '/api/ops/notices', v);
            message.success('公告已发布');
            form.resetFields();
            load();
          } catch (e) { message.error(errOf(e)); }
        }}>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <Input.TextArea rows={3} maxLength={2048} />
          </Form.Item>
          <Form.Item name="level" label="级别" initialValue="INFO">
            <Input placeholder="INFO / WARNING / CRITICAL" />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">发布公告</Button>
            <Button onClick={async () => {
              try { await req('PUT', '/api/ops/notices/deactivate'); message.success('已撤下'); load(); }
              catch (e) { message.error(errOf(e)); }
            }}>撤下当前公告</Button>
          </Space>
        </Form>
      </Card>
      <List
        loading={list === null}
        dataSource={list ?? []}
        locale={{ emptyText: '暂无公告' }}
        renderItem={(n) => (
          <List.Item
            actions={[
              n.active ? <Tag key="a" color="green">生效中</Tag> : <Tag key="a">已撤下</Tag>,
            ]}
          >
            <List.Item.Meta
              title={<Space><Tag color={n.level === 'CRITICAL' ? 'red' : n.level === 'WARNING' ? 'orange' : 'blue'}>{n.level}</Tag>{n.title}</Space>}
              description={n.content}
            />
          </List.Item>
        )}
      />
    </>
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
  React.useEffect(() => watchAuthChannel((msg) => {
    if (msg.type === 'logout') {
      sessionStorage.removeItem('schema_session');
      setSession(null);
    }
  }), []);
  // 401 静默刷新失败 → 回登录页（authFetch 回调注入）
  React.useEffect(() => {
    onSessionExpired = () => {
      sessionStorage.removeItem('schema_session');
      setSession(null);
    };
    return () => { onSessionExpired = null; };
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
              void sdkLogout(BASE).finally(() => {
                broadcastLogout();
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
                { key: 'usage', label: '租户用量', children: <UsageTab /> },
                { key: 'members', label: '成员管理', children: <MembersTab /> },
                { key: 'health', label: '健康状态', children: <HealthTab /> },
                { key: 'notices', label: '维护公告', children: <NoticesTab /> },
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