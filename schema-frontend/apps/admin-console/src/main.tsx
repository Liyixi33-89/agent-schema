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

/**
 * 租户健康总览（10BE §4.1 overview——近 1h 聚合）。
 * 状态契约：后端只下发 db/status 字段（UP/DOWN/DEGRADED），前端不做
 * healthy/degraded/recovering 猜测转换——状态展示严格按后端真源字段渲染。
 */
interface TenantHealthOverview {
  db: string;
  activeUsersLastHour: number;
  apiThroughputLastHour: { calls: number; source: string };
  errorRateLastHour: { errors: number; source: string };
  scriptCompileLastHour: { total: number; success: number; successRate: number | null };
  resourceUsage: { storageMb: number };
  timestamp: string;
}

interface ThroughputPoint { minute: string; calls: number }
interface CompilePoint { hour: string; total: number; success: number; failed: number; blocked: number; medianDurationMs: number | null }
interface RecentErrorItem { kind: string; at: string; type: string; resource: string; userId?: number; durationMs?: number }

/** 状态 Tag 颜色映射（仅按后端字段字面值——未知值灰态展示，不猜测转换）。 */
function statusTag(value: string): React.ReactElement {
  const color = value === 'UP' ? 'green' : value === 'DEGRADED' ? 'orange' : value === 'DOWN' ? 'red' : 'default';
  return <Tag color={color}>{value}</Tag>;
}

function HealthTab(): React.ReactElement {
  const [basic, setBasic] = React.useState<HealthInfo | null>(null);
  const [overview, setOverview] = React.useState<TenantHealthOverview | null>(null);
  const [throughput, setThroughput] = React.useState<ThroughputPoint[] | null>(null);
  const [compile, setCompile] = React.useState<CompilePoint[] | null>(null);
  const [recentErrors, setRecentErrors] = React.useState<RecentErrorItem[] | null>(null);
  /** 加载失败态（后端不可达/无权限——错误后可刷新恢复，不编造统计值）。 */
  const [error, setError] = React.useState<string | null>(null);
  /** 无权限标记（org:manage 缺失 → 403 转提示，区别于网络失败）。 */
  const [forbidden, setForbidden] = React.useState(false);

  const load = React.useCallback(() => {
    setError(null);
    setForbidden(false);
    // 平台级探活（无权限要求——任何登录态可读）
    req('GET', '/api/ops/health')
      .then((r) => setBasic(r as HealthInfo))
      .catch(() => setBasic(null));
    // 租户级聚合（org:manage 闸门——失败区分 403 与其它错误）
    void req('GET', '/api/ops/health/tenant/overview')
      .then((r) => setOverview(r as TenantHealthOverview))
      .catch((e: unknown) => {
        setOverview(null);
        if (e instanceof Error && e.message.includes('403')) setForbidden(true);
        else setError(errOf(e));
      });
    void req('GET', '/api/ops/health/tenant/api-throughput')
      .then((r) => setThroughput(((r as { series?: ThroughputPoint[] }).series ?? []) as ThroughputPoint[]))
      .catch(() => setThroughput(null));
    void req('GET', '/api/ops/health/tenant/script-compile')
      .then((r) => setCompile(((r as { series?: CompilePoint[] }).series ?? []) as CompilePoint[]))
      .catch(() => setCompile(null));
    void req('GET', '/api/ops/health/tenant/recent-errors')
      .then((r) => setRecentErrors(((r as { list?: RecentErrorItem[] }).list ?? []) as RecentErrorItem[]))
      .catch(() => setRecentErrors(null));
  }, []);
  React.useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  if (forbidden) {
    return (
      <Alert
        type="warning" showIcon message="无权查看租户健康详情"
        description="租户级健康聚合接口需要组织管理权限（org:manage）。请联系平台管理员开通，或切换管理员账号。"
      />
    );
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {error ? (
        <Alert
          type="error" showIcon closable
          message="健康数据加载失败"
          description={(
            <Space direction="vertical">
              <span>{error}</span>
              <Button size="small" onClick={load}>重试</Button>
            </Space>
          )}
        />
      ) : null}
      <Space size="large" wrap>
        <Card>
          <Statistic
            title="平台状态（后端真源字段）"
            value={basic ? basic.status : '未知'}
            valueStyle={{ color: basic?.status === 'UP' ? '#3f8600' : '#cf1322' }}
          />
          <div style={{ marginTop: 8 }}>{basic ? statusTag(basic.db) : <Tag>数据库未知</Tag>}</div>
        </Card>
        <Card><Statistic title="近 1h 活跃用户" value={overview?.activeUsersLastHour ?? '—'} /></Card>
        <Card>
          <Statistic
            title="近 1h API 吞吐（漏斗口径）"
            value={overview?.apiThroughputLastHour?.calls ?? '—'}
          />
          {overview ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              来源：{overview.apiThroughputLastHour.source}（埋点采样，非全量请求）
            </Typography.Text>
          ) : null}
        </Card>
        <Card>
          <Statistic title="近 1h 错误计数" value={overview?.errorRateLastHour?.errors ?? '—'} />
          {overview ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              口径：{overview.errorRateLastHour.source}（审计失败 + 编译失败代理）
            </Typography.Text>
          ) : null}
        </Card>
        <Card>
          <Statistic
            title="近 1h 编译成功率"
            value={overview?.scriptCompileLastHour?.successRate ?? '—'}
            suffix={overview?.scriptCompileLastHour?.successRate != null ? '%' : ''}
          />
          {overview ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {overview.scriptCompileLastHour.success}/{overview.scriptCompileLastHour.total} 次
              {overview.scriptCompileLastHour.total === 0 ? '（无样本）' : ''}
            </Typography.Text>
          ) : null}
        </Card>
        <Card><Statistic title="附件存储（MB）" value={overview?.resourceUsage?.storageMb ?? '—'} /></Card>
      </Space>

      <Card size="small" title="API 吞吐时序（近 60 分钟，分钟粒度）">
        {throughput === null ? (
          <Typography.Text type="secondary">吞吐数据不可用（无权限或加载失败）</Typography.Text>
        ) : throughput.length === 0 ? (
          <Typography.Text type="secondary">近 60 分钟无 api.calls 埋点（窗口内无开放 API 调用）</Typography.Text>
        ) : (
          <Table
            rowKey="minute" size="small" pagination={false}
            dataSource={throughput}
            columns={[
              { title: '分钟', dataIndex: 'minute', key: 'minute' },
              { title: '调用量', dataIndex: 'calls', key: 'calls' },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="脚本编译时序（近 24 小时，小时粒度）">
        {compile === null ? (
          <Typography.Text type="secondary">编译数据不可用（无权限或加载失败）</Typography.Text>
        ) : compile.length === 0 ? (
          <Typography.Text type="secondary">近 24 小时无编译任务（窗口内无脚本构建）</Typography.Text>
        ) : (
          <Table
            rowKey="hour" size="small" pagination={false}
            dataSource={compile}
            columns={[
              { title: '小时', dataIndex: 'hour', key: 'hour' },
              { title: '总数', dataIndex: 'total', key: 'total' },
              { title: '成功', dataIndex: 'success', key: 'success' },
              { title: '失败', dataIndex: 'failed', key: 'failed' },
              { title: '安全拦截', dataIndex: 'blocked', key: 'blocked' },
              { title: '中位耗时(ms)', dataIndex: 'medianDurationMs', key: 'medianDurationMs' },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="近期错误事件（审计失败 + 编译失败/安全拦截，倒序）">
        {recentErrors === null ? (
          <Typography.Text type="secondary">错误清单不可用（无权限或加载失败）</Typography.Text>
        ) : recentErrors.length === 0 ? (
          <Typography.Text type="secondary">暂无错误事件</Typography.Text>
        ) : (
          <Table
            rowKey={(r) => `${r.kind}-${r.at}-${r.resource}`} size="small" pagination={{ pageSize: 10 }}
            dataSource={recentErrors}
            columns={[
              { title: '时间', dataIndex: 'at', key: 'at' },
              { title: '类别', dataIndex: 'kind', key: 'kind', render: (k: string) => (
                <Tag color={k === 'BUILD' ? 'orange' : 'red'}>{k === 'BUILD' ? '编译' : '审计'}</Tag>
              ) },
              { title: '类型', dataIndex: 'type', key: 'type' },
              { title: '对象', dataIndex: 'resource', key: 'resource' },
              { title: '耗时(ms)', dataIndex: 'durationMs', key: 'durationMs' },
            ]}
          />
        )}
      </Card>

      <Typography.Text type="secondary">
        检查时间：{overview?.timestamp ?? basic?.timestamp ?? '—'}（30 秒自动刷新）；
        状态字段直接来自后端契约（db/status），前端不做状态转换。
      </Typography.Text>
    </Space>
  );
}

// ---------- SLA 可用性看板 ----------

/**
 * SLA 月度实测（PRD11 §2.1 统计口径——后端 slaMonthly 聚合，前端纯展示不计算）。
 * 全部数值来自后端契约；availability 为 null 表示采样中（不用编译成功率代替 SLA）。
 */
interface SlaMonthly {
  yearMonth: string;
  targetSla: number;
  availability: number | null;
  totalMinutes: number;
  excludedMaintenanceMinutes: number;
  effectiveMinutes: number;
  unavailableMinutes: number;
  incidents: { startAt: string; minutes: number }[];
  sampledMinutes: number;
  basis: Record<string, string>;
}

interface MaintenanceWindow {
  id: number; tenant_id: number; title: string; start_at: string; end_at: string;
  announced_at?: string; status: string;
}

function SlaTab(): React.ReactElement {
  const [data, setData] = React.useState<SlaMonthly | null>(null);
  const [windows, setWindows] = React.useState<MaintenanceWindow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [forbidden, setForbidden] = React.useState(false);
  const [form] = Form.useForm();
  const [month, setMonth] = React.useState<string>(() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
  });

  const load = React.useCallback(() => {
    setError(null);
    setForbidden(false);
    const [y, m] = month.split('-').map(Number);
    void req('GET', `/api/ops/sla/monthly?year=${y}&month=${m}`)
      .then((r) => setData(r as SlaMonthly))
      .catch((e: unknown) => {
        setData(null);
        if (e instanceof Error && e.message.includes('403')) setForbidden(true);
        else setError(errOf(e));
      });
    void req('GET', '/api/ops/sla/maintenance-windows')
      .then((r) => setWindows(((r as { list?: MaintenanceWindow[] }).list ?? []) as MaintenanceWindow[]))
      .catch(() => setWindows(null));
  }, [month]);
  React.useEffect(() => { load(); }, [load]);

  if (forbidden) {
    return (
      <Alert type="warning" showIcon message="无权查看 SLA 看板"
        description="SLA 聚合接口需要组织管理权限（org:manage）。请联系平台管理员开通。" />
    );
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {error ? (
        <Alert type="error" showIcon message="SLA 数据加载失败" description={error}
          action={<Button size="small" onClick={load}>重试</Button>} />
      ) : null}
      <Space size="large" wrap>
        <Input.Search
          defaultValue={month}
          style={{ width: 200 }}
          placeholder="YYYY-MM"
          onSearch={(v) => { if (/^\d{4}-\d{2}$/.test(v)) setMonth(v); }}
          enterButton="查询"
        />
        <Card>
          <Statistic
            title="月度可用性实测"
            value={data?.availability == null ? '采样中' : (data.availability * 100).toFixed(4)}
            suffix={data?.availability == null ? '' : '%'}
            valueStyle={{ color: data?.availability != null && data.availability < data.targetSla ? '#cf1322' : '#3f8600' }}
          />
          {data ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>目标 {data.targetSla * 100}%（未达标红色）</Typography.Text> : null}
        </Card>
        <Card><Statistic title="当月总分钟" value={data?.totalMinutes ?? '—'} /></Card>
        <Card><Statistic title="维护排除分钟（从分母扣除）" value={data?.excludedMaintenanceMinutes ?? '—'} /></Card>
        <Card><Statistic title="有效统计分钟" value={data?.effectiveMinutes ?? '—'} /></Card>
        <Card>
          <Statistic title="不可用分钟（连续≥5min 才计）" value={data?.unavailableMinutes ?? '—'} />
          {data ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>已采样 {data.sampledMinutes} 分钟</Typography.Text> : null}
        </Card>
      </Space>

      {data ? (
        <Card size="small" title="统计口径（可追溯——来自后端契约 basis 字段）">
          <Typography.Paragraph style={{ marginBottom: 4 }}>
            <Typography.Text type="secondary">测量：</Typography.Text>{data.basis.measurement}
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 4 }}>
            <Typography.Text type="secondary">不可用判定：</Typography.Text>{data.basis.unavailableRule}
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 4 }}>
            <Typography.Text type="secondary">排除项：</Typography.Text>{data.basis.exclusion}
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            <Typography.Text type="secondary">数据来源：</Typography.Text>{data.basis.source}
          </Typography.Paragraph>
        </Card>
      ) : null}

      {data && data.incidents.length > 0 ? (
        <Card size="small" title="故障时段（连续不可用段）">
          <Table rowKey="startAt" size="small" pagination={false} dataSource={data.incidents}
            columns={[
              { title: '开始时间', dataIndex: 'startAt', key: 'startAt' },
              { title: '持续分钟', dataIndex: 'minutes', key: 'minutes' },
            ]} />
        </Card>
      ) : null}

      <Card size="small" title="计划内维护窗口（SLA 排除项登记——提前 72h、每月≤1 次、单次≤2h）">
        <Form form={form} layout="inline" style={{ marginBottom: 12 }} onFinish={async (v: {
            title: string; startAt: string; endAt: string; emergency?: boolean;
          }) => {
          try {
            await req('POST', '/api/ops/sla/maintenance-windows', {
              title: v.title, startAt: v.startAt, endAt: v.endAt, emergency: !!v.emergency,
            });
            message.success('维护窗口已登记');
            form.resetFields();
            load();
          } catch (e) { message.error(errOf(e)); }
        }}>
          <Form.Item name="title" rules={[{ required: true }]}><Input placeholder="窗口标题" /></Form.Item>
          <Form.Item name="startAt" rules={[{ required: true }]}><Input placeholder="开始 ISO-8601 如 2026-11-20T02:00:00+08:00" style={{ width: 280 }} /></Form.Item>
          <Form.Item name="endAt" rules={[{ required: true }]}><Input placeholder="结束 ISO-8601" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="emergency" valuePropName="checked" initialValue={false}><Input type="checkbox" />紧急</Form.Item>
          <Button type="primary" htmlType="submit">登记</Button>
        </Form>
        <Table
          rowKey="id" size="small" pagination={false}
          dataSource={windows ?? []}
          locale={{ emptyText: '暂无维护窗口记录' }}
          columns={[
            { title: '标题', dataIndex: 'title', key: 'title' },
            { title: '范围', key: 'range', render: (_: unknown, w: MaintenanceWindow) => `${w.start_at} ~ ${w.end_at}` },
            { title: '级别', dataIndex: 'tenant_id', key: 'tenant_id', render: (t: number) => t === 0 ? <Tag color="blue">平台级</Tag> : <Tag>本租户</Tag> },
            { title: '状态', dataIndex: 'status', key: 'status' },
          ]}
        />
      </Card>
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
                { key: 'usage', label: '租户用量', children: <UsageTab /> },
                { key: 'members', label: '成员管理', children: <MembersTab /> },
                { key: 'health', label: '健康状态', children: <HealthTab /> },
                { key: 'sla', label: 'SLA 看板', children: <SlaTab /> },
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