/**
 * 健康状态 Tab（10BE §4.1 overview + 13BE §6 平台探活）——由 main.tsx 原样拆出，行为不变。
 */
import React from 'react';
import { Alert, Button, Card, Space, Statistic, Table, Tag, Typography } from 'antd';
import { req, errOf, isForbidden } from './api';

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
export function statusTag(value: string): React.ReactElement {
  const color = value === 'UP' ? 'green' : value === 'DEGRADED' ? 'orange' : value === 'DOWN' ? 'red' : 'default';
  return <Tag color={color}>{value}</Tag>;
}

export default function HealthTab(): React.ReactElement {
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
        if (isForbidden(e)) setForbidden(true);
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
