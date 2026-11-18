/**
 * 维护公告 Tab（13BE §6 /api/ops/notices）——由 main.tsx 原样拆出，行为不变。
 */
import React from 'react';
import { Alert, Button, Card, Form, Input, List, Space, Tag, message } from 'antd';
import { req, errOf } from './api';

interface NoticeItem {
  id: number; title: string; content: string; level: string; active: boolean; updated_at?: string;
}

export default function NoticesTab(): React.ReactElement {
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
