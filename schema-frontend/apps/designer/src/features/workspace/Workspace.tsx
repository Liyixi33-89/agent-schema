/**
 * 应用卡片墙（渐进重构第三批——自 main.tsx 原样抽出，行为不变）：
 * 按 myRole 过滤可见性——服务端过滤为准，前端不做权限二次判断（13BE §A.1）。
 */
import React from 'react';
import {
  Button, Card, Col, Empty, Form, Input, Layout, message, Modal, Row, Space, Spin, Tag, Typography,
} from 'antd';
import { api, type AppCard } from './api';
import { ROLE_LABELS, statusTag, handleError } from './shellShared';

export default function Workspace({ onOpenSettings }: { onOpenSettings: (app: AppCard) => void }): React.ReactElement {
  const [list, setList] = React.useState<AppCard[] | null>(null);
  const [keyword, setKeyword] = React.useState('');
  const [createOpen, setCreateOpen] = React.useState(false);
  const [form] = Form.useForm();

  const load = React.useCallback(async (kw?: string) => {
    try {
      const r = await api.listApps(kw);
      setList(r.list);
    } catch (e) {
      handleError(e);
      setList([]);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  return (
    <Layout.Content style={{ padding: 24, maxWidth: 1080, margin: '0 auto', width: '100%' }}>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Input.Search
          placeholder="搜索应用名称/描述"
          style={{ width: 320 }}
          allowClear
          onSearch={(v) => { setKeyword(v); void load(v || undefined); }}
        />
        <Button type="primary" onClick={() => setCreateOpen(true)}>新建应用</Button>
      </Space>
      {list === null ? (
        <div style={{ textAlign: 'center', padding: 64 }}><Spin /></div>
      ) : list.length === 0 ? (
        <Empty description={keyword ? '无匹配应用' : '暂无应用——点击「新建应用」开始'} />
      ) : (
        <Row gutter={[16, 16]}>
          {list.map((app) => (
            <Col key={app.id} xs={24} sm={12} md={8}>
              <Card
                hoverable
                title={<Space>{app.name}{statusTag(app.status)}</Space>}
                onClick={() => onOpenSettings(app)}
              >
                <Typography.Paragraph ellipsis={{ rows: 2 }} type="secondary">
                  {app.description ?? '暂无描述'}
                </Typography.Paragraph>
                <Space wrap>
                  {(app.myRole ?? []).map((r) => (
                    <Tag key={r} color="blue">{ROLE_LABELS[r] ?? r}</Tag>
                  ))}
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}
      <Modal
        title="新建应用"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await api.createApp(v.name, v.description);
            message.success('应用已创建');
            setCreateOpen(false);
            form.resetFields();
            void load(keyword || undefined);
          } catch (e) {
            handleError(e);
          }
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="应用名称" rules={[{ required: true, message: '请输入应用名称' }]}>
            <Input maxLength={64} placeholder="如：报销管理" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea maxLength={512} rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Layout.Content>
  );
}
