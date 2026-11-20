/**
 * 成员管理页签（渐进重构第三批——自 main.tsx 原样抽出，行为不变）：
 * 角色复用 IAM 应用级角色（app_admin/developer/user）；最后一名应用管理员不可移除。
 */
import React from 'react';
import {
  Button, Form, Input, List, message, Modal, Popconfirm, Select, Space, Typography,
} from 'antd';
import { api, type MemberRow } from './api';
import { handleError } from './shellShared';

const ALL_ROLES = [
  { value: 'app_admin', label: '应用管理员' },
  { value: 'developer', label: '开发者' },
  { value: 'user', label: '使用者' },
];

export default function MembersTab({ appId }: { appId: number }): React.ReactElement {
  const [list, setList] = React.useState<MemberRow[] | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [form] = Form.useForm();

  const load = React.useCallback(async () => {
    try {
      setList((await api.listMembers(appId)).list);
    } catch (e) {
      handleError(e);
      setList([]);
    }
  }, [appId]);
  React.useEffect(() => { void load(); }, [load]);

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setAddOpen(true)}>添加成员</Button>
        <Typography.Text type="secondary">角色复用 IAM 应用级角色（app_admin/developer/user）；最后一名应用管理员不可移除。</Typography.Text>
      </Space>
      <List
        loading={list === null}
        dataSource={list ?? []}
        renderItem={(m) => (
          <List.Item
            actions={[
              <Select
                key="roles"
                mode="multiple"
                style={{ minWidth: 260 }}
                value={m.roles}
                options={ALL_ROLES}
                onChange={async (roles: string[]) => {
                  try {
                    await api.updateMember(appId, m.userId, roles);
                    message.success('角色已更新');
                    void load();
                  } catch (e) { handleError(e); }
                }}
              />,
              <Popconfirm
                key="rm"
                title="确认移除该成员？"
                onConfirm={async () => {
                  try {
                    await api.removeMember(appId, m.userId);
                    message.success('已移除');
                    void load();
                  } catch (e) { handleError(e); }
                }}
              >
                <Button danger size="small">移除</Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta title={m.name ?? m.account} description={m.account} />
          </List.Item>
        )}
      />
      <Modal
        title="添加成员"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await api.addMember(appId, Number(v.userId), v.roles ?? ['user']);
            message.success('已添加');
            setAddOpen(false);
            form.resetFields();
            void load();
          } catch (e) { handleError(e); }
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="userId" label="用户 ID" rules={[{ required: true, message: '请输入用户 ID' }]}>
            <Input type="number" placeholder="成员用户 ID（须属本租户）" />
          </Form.Item>
          <Form.Item name="roles" label="角色" initialValue={['user']}>
            <Select mode="multiple" options={ALL_ROLES} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
