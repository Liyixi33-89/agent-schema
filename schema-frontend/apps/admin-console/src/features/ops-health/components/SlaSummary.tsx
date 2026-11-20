/**
 * SLA 展示组件（阶段 C 范例——props 进/回调出）：
 * 月度统计卡片区 + 口径说明 + 故障时段 + 维护窗口表单/列表。
 */
import React from 'react';
import { Button, Card, Form, Input, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import type { MaintenanceWindow, SlaMonthly } from '../contracts';

/** 月度统计卡片区（availability null=采样中，不转 100%——口径红线）。 */
export function SlaSummary({ data, stale }: { data: SlaMonthly | null; stale: boolean }): React.ReactElement {
  return (
    <>
      {stale ? (
        <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8 }}>
          刷新失败——以下为最近一次成功获取的数据（非实时）
        </Typography.Text>
      ) : null}
      <Space size="large" wrap>
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
    </>
  );
}

/** 统计口径卡（可追溯——basis 字段真源直显）。 */
export function SlaBasisCard({ data }: { data: SlaMonthly }): React.ReactElement {
  return (
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
  );
}

export function IncidentsCard({ data }: { data: { startAt: string; minutes: number }[] }): React.ReactElement {
  return (
    <Card size="small" title="故障时段（连续不可用段）">
      <Table rowKey="startAt" size="small" pagination={false} dataSource={data}
        columns={[
          { title: '开始时间', dataIndex: 'startAt', key: 'startAt' },
          { title: '持续分钟', dataIndex: 'minutes', key: 'minutes' },
        ]} />
    </Card>
  );
}

/**
 * 维护窗口登记表单 + 列表。
 * 表单校验/提交状态在组件内（表单态是组件局部职责），请求执行走 onSubmit 回调——
 * 失败提示由回调返回值驱动（不重复弹窗逻辑）。
 */
export function MaintenanceWindowSection({ windows, onSubmit }: {
  windows: MaintenanceWindow[] | null;
  onSubmit: (input: { title: string; startAt: string; endAt: string; emergency: boolean }) => Promise<{ ok: true } | { ok: false; message: string }>;
}): React.ReactElement {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = React.useState(false);
  return (
    <Card size="small" title="计划内维护窗口（SLA 排除项登记——提前 72h、每月≤1 次、单次≤2h）">
      <Form form={form} layout="inline" style={{ marginBottom: 12 }} onFinish={async (v: {
          title: string; startAt: string; endAt: string; emergency?: boolean;
        }) => {
        setSubmitting(true);
        try {
          const r = await onSubmit({
            title: v.title, startAt: v.startAt, endAt: v.endAt, emergency: !!v.emergency,
          });
          if (r.ok) {
            message.success('维护窗口已登记');
            form.resetFields();
          } else {
            message.error(r.message); // 失败不 resetFields、不显示成功——提交失败红线
          }
        } finally {
          setSubmitting(false);
        }
      }}>
        <Form.Item name="title" rules={[{ required: true }]}><Input placeholder="窗口标题" /></Form.Item>
        <Form.Item name="startAt" rules={[{ required: true }]}><Input placeholder="开始 ISO-8601 如 2026-11-20T02:00:00+08:00" style={{ width: 280 }} /></Form.Item>
        <Form.Item name="endAt" rules={[{ required: true }]}><Input placeholder="结束 ISO-8601" style={{ width: 220 }} /></Form.Item>
        <Form.Item name="emergency" valuePropName="checked" initialValue={false}><Input type="checkbox" />紧急</Form.Item>
        <Button type="primary" htmlType="submit" disabled={submitting}>{submitting ? '登记中…' : '登记'}</Button>
      </Form>
      <Table
        rowKey="id" size="small" pagination={false}
        dataSource={windows ?? []}
        locale={{ emptyText: '暂无维护窗口记录' }}
        columns={[
          { title: '标题', dataIndex: 'title', key: 'title' },
          { title: '范围', key: 'range', render: (_: unknown, w: MaintenanceWindow) => `${w.startAt} ~ ${w.endAt}` },
          { title: '级别', key: 'tenant', render: (_: unknown, w: MaintenanceWindow) => w.tenantId === 0 ? <Tag color="blue">平台级</Tag> : <Tag>本租户</Tag> },
          { title: '状态', dataIndex: 'status', key: 'status' },
        ]}
      />
    </Card>
  );
}
