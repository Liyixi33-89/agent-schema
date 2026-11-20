/**
 * 成员管理页（feature 内聚：页面只编排——取数 Hook + 表单提交 + 展示装配）。
 * 展示组件不自行请求；错误/加载/刷新状态由 RegionStatusBar 如实呈现。
 */
import React from 'react';
import { Button, Card, Form, Input, Table, Tag, message } from 'antd';
import { errOf } from '../../api';
import { RegionStatusBar } from '../../shared/ui';
import { createMember } from './api';
import { useMembers } from './useMembers';

export default function MembersPage(): React.ReactElement {
  const members = useMembers();
  const [form] = Form.useForm();
  const reload = members.reload;

  return (
    <>
      <Card size="small" style={{ marginBottom: 12 }} title="新建成员">
        <Form form={form} layout="inline" onFinish={async (v: { account: string; name: string }) => {
          try {
            await createMember(v);
            message.success('成员已创建（初始密码仅返回一次）');
            form.resetFields();
            reload();
          } catch (e) { message.error(errOf(e)); }
        }}>
          <Form.Item name="account" rules={[{ required: true }]}><Input placeholder="账号" /></Form.Item>
          <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="姓名" /></Form.Item>
          <Button type="primary" htmlType="submit">创建</Button>
        </Form>
      </Card>
      <div style={{ marginBottom: 8 }}><RegionStatusBar status={members} label="成员列表" /></div>
      <Table
        rowKey="id"
        loading={members.loading}
        dataSource={members.data ?? []}
        columns={[
          { title: 'ID', dataIndex: 'id', key: 'id', width: 80 },
          { title: '账号', dataIndex: 'account', key: 'account' },
          { title: '姓名', dataIndex: 'name', key: 'name' },
          {
            title: '状态', dataIndex: 'status', key: 'status',
            render: (s: string) => s === 'ACTIVE' ? <Tag color="green">正常</Tag> : <Tag color="red">停用</Tag>,
          },
        ]}
        pagination={{ pageSize: 10 }}
      />
    </>
  );
}