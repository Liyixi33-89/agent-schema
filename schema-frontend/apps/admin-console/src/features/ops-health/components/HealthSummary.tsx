/**
 * 健康/SLA 展示组件（阶段 C 范例——props 进/回调出，不自行请求、不读全局账号）。
 */
import React from 'react';
import { Alert, Button, Card, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { CompilePoint, HealthInfo, RecentErrorItem, TenantHealthOverview, ThroughputPoint } from '../contracts';

/** 状态 Tag 颜色映射（仅按后端字段字面值——未知值灰态，不猜测转换）。 */
export function statusTag(value: string): React.ReactElement {
  const color = value === 'UP' ? 'green' : value === 'DEGRADED' ? 'orange' : value === 'DOWN' ? 'red' : 'default';
  return <Tag color={color}>{value}</Tag>;
}
export default statusTag;

/** 平台状态 + 概览统计卡片区。 */
export function HealthSummary({ basic, overview, stale }: {
  basic: HealthInfo | null;
  overview: TenantHealthOverview | null;
  /** 刷新失败但保留旧数据——必须提示非最新（不能当最新结果展示）。 */
  stale: boolean;
}): React.ReactElement {
  return (
    <>
      {stale ? (
        <Alert type="warning" showIcon message="刷新失败，以下为最近一次成功获取的数据（非实时）"
          description="自动刷新将在下一周期重试；也可点击上方「重试」立即刷新。" />
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
          <Statistic title="近 1h API 吞吐（漏斗口径）" value={overview?.apiThroughputLastHour?.calls ?? '—'} />
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
    </>
  );
}

/** 三态时序表区（null=不可用 / []=无样本 / 有数据=Table）——通用化健康三块数据区。
 *  行级字段由各包装组件（ThroughputSeries 等）的 columns render 收窄——此处只管三态与表格骨架。 */
export function SeriesCard<T extends object>({ title, unavailableText, emptyText, data, columns, rowKey }: {
  title: string;
  unavailableText: string;
  emptyText: string;
  data: readonly T[] | null;
  columns: { title: string; dataIndex: string; key: string; render?: (v: unknown, row: T) => React.ReactNode }[];
  rowKey: (r: T) => string;
}): React.ReactElement {
  return (
    <Card size="small" title={title}>
      {data === null ? (
        <Typography.Text type="secondary">{unavailableText}</Typography.Text>
      ) : data.length === 0 ? (
        <Typography.Text type="secondary">{emptyText}</Typography.Text>
      ) : (
        <Table<T> rowKey={rowKey} size="small" pagination={false} dataSource={data as unknown as T[]} columns={columns} />
      )}
    </Card>
  );
}

export function ThroughputSeries({ data }: { data: ThroughputPoint[] | null }): React.ReactElement {
  return (
    <SeriesCard
      title="API 吞吐时序（近 60 分钟，分钟粒度）"
      unavailableText="吞吐数据不可用（无权限或加载失败）"
      emptyText="近 60 分钟无 api.calls 埋点（窗口内无开放 API 调用）"
      data={data}
      rowKey={(r) => String(r.minute)}
      columns={[
        { title: '分钟', dataIndex: 'minute', key: 'minute' },
        { title: '调用量', dataIndex: 'calls', key: 'calls' },
      ]}
    />
  );
}

export function CompileSeries({ data }: { data: CompilePoint[] | null }): React.ReactElement {
  return (
    <SeriesCard
      title="脚本编译时序（近 24 小时，小时粒度）"
      unavailableText="编译数据不可用（无权限或加载失败）"
      emptyText="近 24 小时无编译任务（窗口内无脚本构建）"
      data={data}
      rowKey={(r) => String(r.hour)}
      columns={[
        { title: '小时', dataIndex: 'hour', key: 'hour' },
        { title: '总数', dataIndex: 'total', key: 'total' },
        { title: '成功', dataIndex: 'success', key: 'success' },
        { title: '失败', dataIndex: 'failed', key: 'failed' },
        { title: '安全拦截', dataIndex: 'blocked', key: 'blocked' },
        { title: '中位耗时(ms)', dataIndex: 'medianDurationMs', key: 'medianDurationMs' },
      ]}
    />
  );
}

export function RecentErrorsTable({ data }: { data: RecentErrorItem[] | null }): React.ReactElement {
  return (
    <SeriesCard
      title="近期错误事件（审计失败 + 编译失败/安全拦截，倒序）"
      unavailableText="错误清单不可用（无权限或加载失败）"
      emptyText="暂无错误事件"
      data={data}
      rowKey={(r) => `${r.kind}-${r.at}-${r.resource}`}
      columns={[
        { title: '时间', dataIndex: 'at', key: 'at' },
        {
          title: '类别', dataIndex: 'kind', key: 'kind',
          render: (k: unknown) => (
            <Tag color={k === 'BUILD' ? 'orange' : 'red'}>{k === 'BUILD' ? '编译' : '审计'}</Tag>
          ),
        },
        { title: '类型', dataIndex: 'type', key: 'type' },
        { title: '对象', dataIndex: 'resource', key: 'resource' },
        { title: '耗时(ms)', dataIndex: 'durationMs', key: 'durationMs' },
      ]}
    />
  );
}

/** 无权限整页引导（org:manage 缺失——两页共用文案由页面传入）。 */
export function ForbiddenAlert({ title, description }: { title: string; description: string }): React.ReactElement {
  return <Alert type="warning" showIcon message={title} description={description} />;
}

/** 加载失败 Alert（带重试回调——重试语义留在页面/Hook，组件只回调）。 */
export function ErrorRetryAlert({ message, description, onRetry }: {
  message: string; description?: string; onRetry: () => void;
}): React.ReactElement {
  return (
    <Alert
      type="error" showIcon closable message={message}
      description={(
        <Space direction="vertical">
          <span>{description ?? null}</span>
          <Button size="small" onClick={onRetry}>重试</Button>
        </Space>
      )}
    />
  );
}
