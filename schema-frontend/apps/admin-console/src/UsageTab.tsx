/**
 * 租户用量 Tab（09BE /api/metering/usage/summary）——由 main.tsx 原样拆出，行为不变。
 */
import React from 'react';
import { Alert, Card, Space, Statistic, Table, Typography } from 'antd';
import { req, errOf } from './api';

interface UsageSummary {
  licensedSeats?: number;
  activeSeats?: number;
  metrics?: { metric: string; today?: number; total?: number }[];
}

export default function UsageTab(): React.ReactElement {
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
