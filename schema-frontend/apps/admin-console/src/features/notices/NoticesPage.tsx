/**
 * 维护公告页（feature 内聚：页面只编排——取数 Hook + 表单提交 + 展示装配）。
 */
import React from 'react';
import { Button, Card, Form, Input, List, Space, Tag, message } from 'antd';
import { errOf } from '../../api';
import { RegionStatusBar } from '../../shared/ui';
import { useAsyncData } from '../../shared/async';
import { deactivateNotice, fetchNotices, publishNotice } from './api';

export default function NoticesPage(): React.ReactElement {
  const notices = useAsyncData(fetchNotices, []);
  const [form] = Form.useForm();
  const reload = notices.reload;

  return (
    <>
      <Card size="small" style={{ marginBottom: 12 }} title="发布维护公告（发布即生效，撤销旧公告）">
        <Form form={form} layout="vertical" style={{ maxWidth: 520 }} onFinish={async (v: {
          title: string; content: string; level: string;
        }) => {
          try {
            await publishNotice(v);
            message.success('公告已发布');
            form.resetFields();
            reload();
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
              try { await deactivateNotice(); message.success('已撤下'); reload(); }
              catch (e) { message.error(errOf(e)); }
            }}>撤下当前公告</Button>
          </Space>
        </Form>
      </Card>
      <div style={{ marginBottom: 8 }}><RegionStatusBar status={notices} label="公告列表" /></div>
      <List
        loading={notices.loading}
        dataSource={notices.data ?? []}
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