/**
 * 成员管理 Tab（03BE /api/org/members）——由 main.tsx 原样拆出，行为不变。
 */
import React from 'react';
import { Alert, Button, Card, Form, Input, Table, Tag, message } from 'antd';
import { req, errOf } from './api';

interface MemberItem { id: number; account: string; name?: string; status: string }

export default function MembersTab(): React.ReactElement {
  const [list, setList] = React.useState<MemberItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [form] = Form.useForm();
  const load = React.useCallback(() => {
    req('GET', '/api/org/members')
      .then((r) => setList(((r as { list?: MemberItem[] }).list ?? []) as MemberItem[]))
      .catch((e) => setError(errOf(e)));
  }, []);
  React.useEffect(() => { load(); }, [load]);

  if (error) return <Alert type="error" showIcon message="成员加载失败" description={error} />;
  return (
    <>
      <Card size="small" style={{ marginBottom: 12 }} title="新建成员">
        <Form form={form} layout="inline" onFinish={async (v: { account: string; name: string }) => {
          try {
            await req('POST', '/api/org/members', v);
            message.success('成员已创建（初始密码仅返回一次）');
            form.resetFields();
            load();
          } catch (e) { message.error(errOf(e)); }
        }}>
          <Form.Item name="account" rules={[{ required: true }]}><Input placeholder="账号" /></Form.Item>
          <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="姓名" /></Form.Item>
          <Button type="primary" htmlType="submit">创建</Button>
        </Form>
      </Card>
      <Table
        rowKey="id"
        loading={list === null}
        dataSource={list ?? []}
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
