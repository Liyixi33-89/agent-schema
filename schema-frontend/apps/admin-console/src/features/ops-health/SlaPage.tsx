/**
 * SLA 可用性看板页（阶段 C 范例——编排：月度查询 + 权限引导 + 维护窗口登记）。
 * 行为基线：month 切换重载、availability null=采样中、口径 basis 真源直显、维护窗口登记后刷新。
 * 本轮修复：月度与维护窗口两区域各自展示加载/刷新/失败状态；月份切换期间不展示旧月份数据。
 */
import React from 'react';
import { Input, Space, Typography } from 'antd';
import { useSlaData } from './useSlaData';
import { ErrorRetryAlert, ForbiddenAlert, RegionStatusBar } from '../../shared/ui';
import {
  IncidentsCard, MaintenanceWindowSection, SlaBasisCard, SlaSummary,
} from './components/SlaSummary';
import { parseYearMonth } from '../../shared/contracts';

export default function SlaPage(): React.ReactElement {
  const [month, setMonth] = React.useState<string>(() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
  });
  const d = useSlaData(month);

  if (d.monthly.forbidden) {
    return (
      <ForbiddenAlert
        title="无权查看 SLA 看板"
        description="SLA 聚合接口需要组织管理权限（org:manage）。请联系平台管理员开通。"
      />
    );
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {d.monthly.error ? (
        <ErrorRetryAlert message="SLA 数据加载失败" description={d.monthly.error} onRetry={d.monthly.reload} />
      ) : null}
      <Space size="large" wrap>
        <Input.Search
          defaultValue={month}
          style={{ width: 200 }}
          placeholder="YYYY-MM"
          onSearch={(v) => { if (parseYearMonth(v)) setMonth(v); }}
          enterButton="查询"
        />
        <Typography.Text type="secondary">当前查询月份：{month}</Typography.Text>
      </Space>
      <div><RegionStatusBar status={d.monthly} label="SLA 月度数据" /></div>
      <SlaSummary data={d.monthly.data} stale={d.monthly.stale} />
      {d.monthly.data ? <SlaBasisCard data={d.monthly.data} /> : null}
      {d.monthly.data && d.monthly.data.incidents.length > 0 ? (
        <IncidentsCard data={d.monthly.data.incidents} />
      ) : null}
      <MaintenanceWindowSection windows={d.windows.data} status={d.windows} onSubmit={d.submitWindow} />
    </Space>
  );
}