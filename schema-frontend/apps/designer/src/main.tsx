/**
 * M11 设计器工作台（13BE §A.1/§A.2）：
 * - 应用卡片墙（按 myRole 过滤可见性——服务端过滤为准，前端不做权限二次判断）
 * - 应用设置四页签：成员 / 导航 / 主题 / 发布
 * - 登录态：localStorage schema_token（与 runtime 同通道）
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Button, Card, Col, ConfigProvider, Empty, Form, Input, Layout, List, message, Modal, Popconfirm,
  Row, Select, Space, Spin, Tabs, Tag, Typography,
} from 'antd';
import { ApiClient, ApiError, type AppCard, type MemberRow, type NavNode, type ReleaseRow } from './api';

const api = new ApiClient();

interface Session {
  account: string;
}

function useSession(): [Session | null, () => void] {
  const [session, setSession] = React.useState<Session | null>(() =>
    localStorage.getItem('schema_token') ? { account: localStorage.getItem('schema_account') ?? '' } : null,
  );
  const logout = React.useCallback(() => {
    localStorage.removeItem('schema_token');
    localStorage.removeItem('schema_refresh');
    localStorage.removeItem('schema_account');
    setSession(null);
  }, []);
  return [session, logout];
}

// ---------- 登录 ----------

function LoginPanel({ onLogin }: { onLogin: (account: string) => void }): React.ReactElement {
  const [form] = Form.useForm();
  const [loading, setLoading] = React.useState(false);
  return (
    <Card title="Schema 设计器 · 登录" style={{ maxWidth: 380, margin: '80px auto' }}>
      <Form form={form} onFinish={async (v: { account: string; password: string }) => {
        setLoading(true);
        try {
          const r = await api.login(v.account, v.password);
          localStorage.setItem('schema_token', r.accessToken);
          if (r.refreshToken) localStorage.setItem('schema_refresh', r.refreshToken);
          localStorage.setItem('schema_account', v.account);
          localStorage.setItem('schema_tenant', localStorage.getItem('schema_tenant') ?? '1');
          onLogin(v.account);
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setLoading(false);
        }
      }}>
        <Form.Item name="account" rules={[{ required: true, message: '请输入账号' }]}>
          <Input placeholder="账号" />
        </Form.Item>
        <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="密码" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading}>登录</Button>
      </Form>
    </Card>
  );
}

// ---------- 应用卡片墙 ----------

const ROLE_LABELS: Record<string, string> = {
  app_admin: '应用管理员', developer: '开发者', user: '使用者',
};

function statusTag(status: string): React.ReactElement {
  if (status === 'ARCHIVED') return <Tag color="orange">已归档</Tag>;
  if (status === 'DELETING') return <Tag color="red">删除中</Tag>;
  return <Tag color="green">使用中</Tag>;
}

function Workspace({ onOpenSettings }: { onOpenSettings: (app: AppCard) => void }): React.ReactElement {
  const [list, setList] = React.useState<AppCard[] | null>(null);
  const [keyword, setKeyword] = React.useState('');
  const [createOpen, setCreateOpen] = React.useState(false);
  const [form] = Form.useForm();

  const load = React.useCallback(async (kw?: string) => {
    try {
      const r = await api.listApps(kw);
      setList(r.list);
    } catch (e) {
      handleError(e);
      setList([]);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  return (
    <Layout.Content style={{ padding: 24, maxWidth: 1080, margin: '0 auto', width: '100%' }}>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Input.Search
          placeholder="搜索应用名称/描述"
          style={{ width: 320 }}
          allowClear
          onSearch={(v) => { setKeyword(v); void load(v || undefined); }}
        />
        <Button type="primary" onClick={() => setCreateOpen(true)}>新建应用</Button>
      </Space>
      {list === null ? (
        <div style={{ textAlign: 'center', padding: 64 }}><Spin /></div>
      ) : list.length === 0 ? (
        <Empty description={keyword ? '无匹配应用' : '暂无应用——点击「新建应用」开始'} />
      ) : (
        <Row gutter={[16, 16]}>
          {list.map((app) => (
            <Col key={app.id} xs={24} sm={12} md={8}>
              <Card
                hoverable
                title={<Space>{app.name}{statusTag(app.status)}</Space>}
                onClick={() => onOpenSettings(app)}
              >
                <Typography.Paragraph ellipsis={{ rows: 2 }} type="secondary">
                  {app.description ?? '暂无描述'}
                </Typography.Paragraph>
                <Space wrap>
                  {(app.myRole ?? []).map((r) => (
                    <Tag key={r} color="blue">{ROLE_LABELS[r] ?? r}</Tag>
                  ))}
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}
      <Modal
        title="新建应用"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await api.createApp(v.name, v.description);
            message.success('应用已创建');
            setCreateOpen(false);
            form.resetFields();
            void load(keyword || undefined);
          } catch (e) {
            handleError(e);
          }
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="应用名称" rules={[{ required: true, message: '请输入应用名称' }]}>
            <Input maxLength={64} placeholder="如：报销管理" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea maxLength={512} rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Layout.Content>
  );
}

// ---------- 应用设置：四页签 ----------

function AppSettings({ app, onBack }: { app: AppCard; onBack: () => void }): React.ReactElement {
  return (
    <Layout.Content style={{ padding: 24, maxWidth: 1080, margin: '0 auto', width: '100%' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={onBack}>← 返回工作台</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>{app.name}</Typography.Title>
        {statusTag(app.status)}
      </Space>
      <Card>
        <Tabs
          items={[
            { key: 'members', label: '成员', children: <MembersTab appId={app.id} /> },
            { key: 'nav', label: '导航', children: <NavTab appId={app.id} /> },
            { key: 'theme', label: '主题', children: <ThemeTab app={app} onBack={onBack} /> },
            { key: 'publish', label: '发布', children: <PublishTab app={app} /> },
          ]}
        />
      </Card>
    </Layout.Content>
  );
}

const ALL_ROLES = [
  { value: 'app_admin', label: '应用管理员' },
  { value: 'developer', label: '开发者' },
  { value: 'user', label: '使用者' },
];

function MembersTab({ appId }: { appId: number }): React.ReactElement {
  const [list, setList] = React.useState<MemberRow[] | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [form] = Form.useForm();

  const load = React.useCallback(async () => {
    try {
      setList((await api.listMembers(appId)).list);
    } catch (e) {
      handleError(e);
      setList([]);
    }
  }, [appId]);
  React.useEffect(() => { void load(); }, [load]);

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setAddOpen(true)}>添加成员</Button>
        <Typography.Text type="secondary">角色复用 IAM 应用级角色（app_admin/developer/user）；最后一名应用管理员不可移除。</Typography.Text>
      </Space>
      <List
        loading={list === null}
        dataSource={list ?? []}
        renderItem={(m) => (
          <List.Item
            actions={[
              <Select
                key="roles"
                mode="multiple"
                style={{ minWidth: 260 }}
                value={m.roles}
                options={ALL_ROLES}
                onChange={async (roles: string[]) => {
                  try {
                    await api.updateMember(appId, m.userId, roles);
                    message.success('角色已更新');
                    void load();
                  } catch (e) { handleError(e); }
                }}
              />,
              <Popconfirm
                key="rm"
                title="确认移除该成员？"
                onConfirm={async () => {
                  try {
                    await api.removeMember(appId, m.userId);
                    message.success('已移除');
                    void load();
                  } catch (e) { handleError(e); }
                }}
              >
                <Button danger size="small">移除</Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta title={m.name ?? m.account} description={m.account} />
          </List.Item>
        )}
      />
      <Modal
        title="添加成员"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await api.addMember(appId, Number(v.userId), v.roles ?? ['user']);
            message.success('已添加');
            setAddOpen(false);
            form.resetFields();
            void load();
          } catch (e) { handleError(e); }
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="userId" label="用户 ID" rules={[{ required: true, message: '请输入用户 ID' }]}>
            <Input type="number" placeholder="成员用户 ID（须属本租户）" />
          </Form.Item>
          <Form.Item name="roles" label="角色" initialValue={['user']}>
            <Select mode="multiple" options={ALL_ROLES} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

interface FlatNavRow {
  key: string;
  node: NavNode;
  depth: number;
}

function flattenNav(tree: NavNode[], depth = 0, out: FlatNavRow[] = []): FlatNavRow[] {
  for (const n of tree) {
    out.push({ key: n.id, node: n, depth });
    if (n.children?.length) flattenNav(n.children, depth + 1, out);
  }
  return out;
}

function NavTab({ appId }: { appId: number }): React.ReactElement {
  const [tree, setTree] = React.useState<NavNode[] | null>(null);
  const [version, setVersion] = React.useState(0);
  const [draft, setDraft] = React.useState<NavNode[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const [pages, setPages] = React.useState<{ id: number; name: string }[]>([]);
  // 新增节点弹层（类型三选：PAGE 引用本应用页面 / LINK 外链 / GROUP 分组）
  const [addOpen, setAddOpen] = React.useState(false);
  const [addForm] = Form.useForm();

  const load = React.useCallback(async () => {
    try {
      const r = await api.getNav(appId);
      setTree(r.tree);
      setVersion(r.version);
      setDraft(r.tree);
      setDirty(false);
    } catch (e) { handleError(e); setTree([]); }
  }, [appId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    void api.listPages(appId).then((r) => setPages(r.list)).catch(() => setPages([]));
  }, [appId]);

  const rows = flattenNav(draft);

  const move = (idx: number, dir: -1 | 1): void => {
    // 同层平移：简化实现——顶层节点排序（GROUP 内子节点经编辑 JSON 处理，MVP 取舍）
    if (rows[idx].depth !== 0) return;
    const top = [...draft];
    const target = idx + dir;
    if (target < 0 || target >= top.length) return;
    [top[idx], top[target]] = [top[target], top[idx]];
    setDraft(top);
    setDirty(true);
  };

  /** 移除节点（含 GROUP 整枝）；顶层直接过滤，嵌套递归剪枝。 */
  const removeNode = (nodes: NavNode[], id: string): NavNode[] =>
    nodes.filter((n) => n.id !== id).map((n) => (
      n.children?.length ? { ...n, children: removeNode(n.children, id) } : n
    ));

  const genId = (): string => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" disabled={!dirty}
          onClick={async () => {
            try {
              const r = await api.saveNav(appId, draft, version);
              message.success(`导航已保存（v${r.version}）`);
              void load();
            } catch (e) {
              if (e instanceof ApiError && e.code === 'NAV_VERSION_CONFLICT') {
                message.error('版本冲突：他人已更新导航，请刷新后重试');
                void load();
              } else {
                handleError(e);
              }
            }
          }}
        >保存导航</Button>
        <Button onClick={() => { setDraft(tree ?? []); setDirty(false); }}>放弃修改</Button>
        <Button onClick={() => { addForm.resetFields(); setAddOpen(true); }}>新增节点</Button>
        <Typography.Text type="secondary">
          当前版本 v{version}{dirty ? ' · 有未保存修改' : ''}；PAGE 节点须引用本应用页面；保存冲突返回 409。
        </Typography.Text>
      </Space>
      <List
        loading={tree === null}
        dataSource={rows}
        renderItem={(row, idx) => (
          <List.Item
            actions={row.depth === 0 ? ([
              <Button key="up" size="small" disabled={idx === 0} onClick={() => move(idx, -1)}>上移</Button>,
              <Button key="down" size="small" disabled={idx === rows.length - 1} onClick={() => move(idx, 1)}>下移</Button>,
              <Popconfirm
                key="del"
                title="删除该节点？（GROUP 含子节点整枝删除）"
                onConfirm={() => {
                  setDraft(removeNode(draft, row.key));
                  setDirty(true);
                }}
              >
                <Button danger size="small">删除</Button>
              </Popconfirm>,
            ]) : []}
          >
            <Space style={{ paddingLeft: row.depth * 24 }}>
              <Tag>{row.node.type}</Tag>
              <span>{row.node.label}</span>
              {row.node.type === 'PAGE' && <Typography.Text type="secondary">→ 页面 #{row.node.refId}</Typography.Text>}
              {row.node.type === 'LINK' && <Typography.Text type="secondary">{row.node.url}</Typography.Text>}
            </Space>
          </List.Item>
        )}
      />
      <Modal
        title="新增导航节点（追加到顶层）"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={async () => {
          const v = await addForm.validateFields();
          const node: NavNode = { id: genId(), type: v.type, label: v.label };
          if (v.type === 'PAGE') node.refId = Number(v.refId);
          if (v.type === 'LINK') node.url = v.url;
          if (v.type === 'GROUP') node.children = [];
          setDraft([...draft, node]);
          setDirty(true);
          setAddOpen(false);
        }}
      >
        <Form form={addForm} layout="vertical" initialValues={{ type: 'PAGE' }}>
          <Form.Item name="type" label="节点类型" rules={[{ required: true }]}>
            <Select options={[
              { value: 'PAGE', label: '页面（引用本应用 ACTIVE 页面）' },
              { value: 'GROUP', label: '分组（子节点需后续填充）' },
              { value: 'LINK', label: '外链（http/https）' },
            ]} />
          </Form.Item>
          <Form.Item name="label" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.type !== b.type}>
            {({ getFieldValue }) => {
              const t = getFieldValue('type');
              if (t === 'PAGE') {
                return (
                  <Form.Item name="refId" label="引用页面" rules={[{ required: true, message: '请选择页面' }]}>
                    <Select
                      placeholder="选择本应用页面"
                      options={pages.map((p) => ({ value: p.id, label: `${p.name} (#${p.id})` }))}
                    />
                  </Form.Item>
                );
              }
              if (t === 'LINK') {
                return (
                  <Form.Item name="url" label="链接地址"
                    rules={[{ required: true, message: '请输入链接' }, {
                      pattern: /^https?:\/\//i, message: '仅允许 http(s) 地址',
                    }]}>
                    <Input placeholder="https://..." />
                  </Form.Item>
                );
              }
              return null;
            }}
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function ThemeTab({ app, onBack }: { app: AppCard; onBack: () => void }): React.ReactElement {
  const [form] = Form.useForm();
  const [saving, setSaving] = React.useState(false);
  // 两段式删除（13BE §3.1 P1）：precheck 影响面 → 输入完整应用名确认
  const [delOpen, setDelOpen] = React.useState(false);
  const [delImpact, setDelImpact] = React.useState<Record<string, unknown> | null>(null);
  const [delConfirm, setDelConfirm] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => {
    void api.appDetail(app.id).then((d) => {
      let theme: Record<string, unknown> = {};
      try { theme = d.theme ? (JSON.parse(d.theme) as Record<string, unknown>) : {}; } catch { theme = {}; }
      form.setFieldsValue({
        name: d.name,
        description: d.description,
        primaryColor: (theme.primaryColor as string) ?? '#1677ff',
      });
    }).catch((e) => handleError(e));
  }, [app.id, form]);

  const openDelete = async (): Promise<void> => {
    try {
      const pre = await api.deletePrecheck(app.id);
      setDelImpact(pre.impact);
      setDelConfirm('');
      setDelOpen(true);
    } catch (e) { handleError(e); }
  };

  return (
    <>
    <Form form={form} layout="vertical" style={{ maxWidth: 480 }}
      onFinish={async (v: { name: string; description?: string; primaryColor?: string }) => {
        setSaving(true);
        try {
          await api.updateApp(app.id, {
            name: v.name,
            description: v.description,
            theme: JSON.stringify({ primaryColor: v.primaryColor ?? '#1677ff' }),
          });
          message.success('已保存');
        } catch (e) { handleError(e); } finally { setSaving(false); }
      }}>
      <Form.Item name="name" label="应用名称" rules={[{ required: true }]}>
        <Input maxLength={64} />
      </Form.Item>
      <Form.Item name="description" label="描述">
        <Input.TextArea rows={2} maxLength={512} />
      </Form.Item>
      <Form.Item name="primaryColor" label="主题色">
        <Input placeholder="#1677ff" />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
        {app.status === 'ACTIVE' && (
          <Popconfirm title="归档后全部资源只读，运行时访问保留。确认归档？" onConfirm={async () => {
            try {
              await api.archiveApp(app.id);
              message.success('已归档');
              onBack();   // 返回卡片墙重载状态（归档后默认列表不可见——includeArchived 开关控制）
            } catch (e) { handleError(e); }
          }}>
            <Button danger>归档应用</Button>
          </Popconfirm>
        )}
        {app.status === 'ARCHIVED' && (
          <Button onClick={async () => {
            try { await api.restoreApp(app.id); message.success('已恢复'); onBack(); } catch (e) { handleError(e); }
          }}>恢复编辑</Button>
        )}
        {app.status !== 'DELETING' && (
          <Button danger type="dashed" onClick={() => { void openDelete(); }}>删除应用…</Button>
        )}
      </Space>
    </Form>
    <Modal
      title="删除应用（不可恢复进入 DELETING）"
      open={delOpen}
      onCancel={() => setDelOpen(false)}
      okText="确认删除"
      okButtonProps={{ danger: true, disabled: delConfirm.trim() !== app.name, loading: deleting }}
      onOk={async () => {
        setDeleting(true);
        try {
          await api.deleteApp(app.id, delConfirm.trim());
          message.success('应用已进入 DELETING');
          setDelOpen(false);
          onBack();
        } catch (e) { handleError(e); } finally { setDeleting(false); }
      }}
    >
      <Typography.Paragraph type="danger">
        删除影响面：{delImpact ? Object.entries(delImpact)
          .filter(([k]) => k !== 'appName')
          .map(([k, v]) => `${k}: ${String(v)}`).join('、') : '加载中…'}
      </Typography.Paragraph>
      <Typography.Paragraph>
        {'请输入完整应用名 '}
        <Typography.Text code>{app.name}</Typography.Text>
        {' 确认删除：'}
      </Typography.Paragraph>
      <Input value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} placeholder={app.name} />
    </Modal>
    </>
  );
}

function PublishTab({ app }: { app: AppCard }): React.ReactElement {
  const [releases, setReleases] = React.useState<ReleaseRow[] | null>(null);
  const [publishing, setPublishing] = React.useState(false);
  const load = React.useCallback(async () => {
    try {
      setReleases((await api.listReleases(app.id)).list);
    } catch (e) { handleError(e); setReleases([]); }
  }, [app.id]);
  React.useEffect(() => { void load(); }, [load]);

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" loading={publishing} onClick={async () => {
          setPublishing(true);
          try {
            await api.publish(app.id);
            message.success('已发布');
            void load();
          } catch (e) { handleError(e); } finally { setPublishing(false); }
        }}>发布全部页面</Button>
        <Typography.Text type="secondary">发布生成应用级快照（不可变）；运行时按 ETag 缓存读取。</Typography.Text>
      </Space>
      <List
        loading={releases === null}
        dataSource={releases ?? []}
        locale={{ emptyText: '暂无发布记录' }}
        renderItem={(r) => (
          <List.Item>
            <Space>
              <Tag color="blue">v{r.version}</Tag>
              <span>操作者 {String(r.operator ?? '-')}</span>
              <Typography.Text type="secondary">{r.releasedAt ?? ''}</Typography.Text>
            </Space>
          </List.Item>
        )}
      />
    </>
  );
}

function handleError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  message.error(msg);
}

// ---------- 入口 ----------

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