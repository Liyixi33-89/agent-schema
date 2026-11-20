/**
 * SLA 可用性看板页（阶段 C 范例——编排：月度查询 + 权限引导 + 维护窗口登记）。
 * 行为基线：month 切换重载、availability null=采样中、口径 basis 真源直显、维护窗口登记后刷新。
 */
import React from 'react';
import { Card, Input, Space } from 'antd';
import { useSlaData } from './useSlaData';
import { ErrorRetryAlert, ForbiddenAlert } from './components/HealthSummary';
import {
  IncidentsCard, MaintenanceWindowSection, SlaBasisCard, SlaSummary,
} from './components/SlaSummary';
import { parseYearMonth } from './contracts';

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
      </Space>
      <SlaSummary data={d.monthly.data} stale={d.monthly.stale} />
      {d.monthly.data ? <SlaBasisCard data={d.monthly.data} /> : null}
      {d.monthly.data && d.monthly.data.incidents.length > 0 ? (
        <IncidentsCard data={d.monthly.data.incidents} />
      ) : null}
      <MaintenanceWindowSection windows={d.windows.data} onSubmit={d.submitWindow} />
    </Space>
  );
}
