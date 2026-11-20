/**
 * 租户用量页（feature 内聚：页面只编排——取数 Hook + 展示装配）。
 */
import React from 'react';
import { Card, Space, Statistic, Table } from 'antd';
import { RegionStatusBar } from '../../shared/ui';
import { useAsyncData } from '../../shared/async';
import { fetchUsageSummary } from './api';

export default function UsagePage(): React.ReactElement {
  const usage = useAsyncData(fetchUsageSummary, []);
  const data = usage.data;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <div><RegionStatusBar status={usage} label="用量数据" /></div>
      <Space size="large">
        <Card><Statistic title="授权席位（设计能力口径）" value={data?.licensedSeats ?? '—'} /></Card>
        <Card><Statistic title="活跃席位（30 天窗口）" value={data?.activeSeats ?? '—'} /></Card>
      </Space>
      <Table
        rowKey="metric"
        loading={usage.loading}
        dataSource={data?.metrics ?? []}
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