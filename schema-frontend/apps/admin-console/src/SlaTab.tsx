/**
 * SLA 可用性看板 Tab（PRD11 §2.1 统计口径——后端 slaMonthly 聚合）——由 main.tsx 原样拆出，行为不变。
 * 全部数值来自后端契约；availability 为 null 表示采样中（不用编译成功率代替 SLA）。
 */
import React from 'react';
import { Alert, Button, Card, Form, Input, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { req, errOf, isForbidden } from './api';

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

export default function SlaTab(): React.ReactElement {
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
        if (isForbidden(e)) setForbidden(true);
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
