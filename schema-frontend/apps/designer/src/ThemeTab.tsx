/**
 * 主题页签（渐进重构第三批——自 main.tsx 原样抽出，行为不变）：
 * 基本信息/主题色编辑 + 归档/恢复 + 两段式删除（precheck 影响面 → 输入完整应用名确认，13BE §3.1 P1）。
 */
import React from 'react';
import { Button, Form, Input, message, Modal, Popconfirm, Space, Typography } from 'antd';
import { api, type AppCard } from './api';
import { handleError } from './shellShared';

export default function ThemeTab({ app, onBack }: { app: AppCard; onBack: () => void }): React.ReactElement {
  const [form] = Form.useForm();
  const [saving, setSaving] = React.useState(false);
  // 两段式删除（13BE §3.1 P1）：precheck 影响面 → 输入完整应用名确认
  const [delOpen, setDelOpen] = React.useState(false);
  const [delImpact, setDelImpact] = React.useState<Record<string, unknown> | null>(null);
  const [delConfirm, setDelConfirm] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => {
    void api.appDetail(app.id).then((d) => {
      let theme: Record<string, unknown> = {};
      try { theme = d.theme ? (JSON.parse(d.theme) as Record<string, unknown>) : {}; } catch { theme = {}; }
      form.setFieldsValue({
        name: d.name,
        description: d.description,
        primaryColor: (theme.primaryColor as string) ?? '#1677ff',
      });
    }).catch((e) => handleError(e));
  }, [app.id, form]);

  const openDelete = async (): Promise<void> => {
    try {
      const pre = await api.deletePrecheck(app.id);
      setDelImpact(pre.impact);
      setDelConfirm('');
      setDelOpen(true);
    } catch (e) { handleError(e); }
  };

  return (
    <>
    <Form form={form} layout="vertical" style={{ maxWidth: 480 }}
      onFinish={async (v: { name: string; description?: string; primaryColor?: string }) => {
        setSaving(true);
        try {
          await api.updateApp(app.id, {
            name: v.name,
            description: v.description,
            theme: JSON.stringify({ primaryColor: v.primaryColor ?? '#1677ff' }),
          });
          message.success('已保存');
        } catch (e) { handleError(e); } finally { setSaving(false); }
      }}>
      <Form.Item name="name" label="应用名称" rules={[{ required: true }]}>
        <Input maxLength={64} />
      </Form.Item>
      <Form.Item name="description" label="描述">
        <Input.TextArea rows={2} maxLength={512} />
      </Form.Item>
      <Form.Item name="primaryColor" label="主题色">
        <Input placeholder="#1677ff" />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
        {app.status === 'ACTIVE' && (
          <Popconfirm title="归档后全部资源只读，运行时访问保留。确认归档？" onConfirm={async () => {
            try {
              await api.archiveApp(app.id);
              message.success('已归档');
              onBack();   // 返回卡片墙重载状态（归档后默认列表不可见——includeArchived 开关控制）
            } catch (e) { handleError(e); }
          }}>
            <Button danger>归档应用</Button>
          </Popconfirm>
        )}
        {app.status === 'ARCHIVED' && (
          <Button onClick={async () => {
            try { await api.restoreApp(app.id); message.success('已恢复'); onBack(); } catch (e) { handleError(e); }
          }}>恢复编辑</Button>
        )}
        {app.status !== 'DELETING' && (
          <Button danger type="dashed" onClick={() => { void openDelete(); }}>删除应用…</Button>
        )}
      </Space>
    </Form>
    <Modal
      title="删除应用（不可恢复进入 DELETING）"
      open={delOpen}
      onCancel={() => setDelOpen(false)}
      okText="确认删除"
      okButtonProps={{ danger: true, disabled: delConfirm.trim() !== app.name, loading: deleting }}
      onOk={async () => {
        setDeleting(true);
        try {
          await api.deleteApp(app.id, delConfirm.trim());
          message.success('应用已进入 DELETING');
          setDelOpen(false);
          onBack();
        } catch (e) { handleError(e); } finally { setDeleting(false); }
      }}
    >
      <Typography.Paragraph type="danger">
        删除影响面：{delImpact ? Object.entries(delImpact)
          .filter(([k]) => k !== 'appName')
          .map(([k, v]) => `${k}: ${String(v)}`).join('、') : '加载中…'}
      </Typography.Paragraph>
      <Typography.Paragraph>
        {'请输入完整应用名 '}
        <Typography.Text code>{app.name}</Typography.Text>
        {' 确认删除：'}
      </Typography.Paragraph>
      <Input value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} placeholder={app.name} />
    </Modal>
    </>
  );
}
