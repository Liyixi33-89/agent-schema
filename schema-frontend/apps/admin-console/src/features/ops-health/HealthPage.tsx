/**
 * 健康状态页（feature 内聚——页面只做编排：数据 Hook + 权限/错误引导 + 展示组件装配）。
 * 行为基线：30s 轮询、403 整页引导、错误重试、时序三态、状态字段后端真源。
 * 每个区域独立展示自身状态（加载/刷新/失败/无权限/非最新），
 * 不因 overview 成功而隐藏吞吐/编译/错误清单的失败。
 */
import React from 'react';
import { Space, Typography } from 'antd';
import { useHealthData } from './useHealthData';
import {
  CompileSeries, ErrorRetryAlert, ForbiddenAlert, HealthSummary, RecentErrorsTable,
  RegionStatusBar, ThroughputSeries,
} from '../../shared/ui';

export default function HealthPage(): React.ReactElement {
  const d = useHealthData();

  if (d.overview.forbidden) {
    return (
      <ForbiddenAlert
        title="无权查看租户健康详情"
        description="租户级健康聚合接口需要组织管理权限（org:manage）。请联系平台管理员开通，或切换管理员账号。"
      />
    );
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {d.overview.error ? (
        <ErrorRetryAlert
          message="健康数据加载失败"
          description={d.overview.error}
          onRetry={d.overview.reload}
        />
      ) : null}
      <HealthSummary basic={d.basic.data} overview={d.overview.data} stale={d.overview.stale} />
      <ThroughputSeries data={d.throughput.data} status={d.throughput} />
      <CompileSeries data={d.compile.data} status={d.compile} />
      <RecentErrorsTable data={d.recentErrors.data} status={d.recentErrors} />
      <Typography.Text type="secondary">
        检查时间：{d.overview.data?.timestamp ?? d.basic.data?.timestamp ?? '—'}（30 秒自动刷新）；
        状态字段直接来自后端契约（db/status），前端不做状态转换。
      </Typography.Text>
    </Space>
  );
}