/**
 * 流程页签（spec 022 T2）：真实接口 + 新建 + 编辑 + 保存草稿（409 冲突保留草稿）+ 发布。
 *
 * ## 与 020 阶段 A 的差别
 * 020 是只读演示（`DEMO_FLOWS` fixture + 无编辑入口）。
 * 022 接入 021 的后端 API，形成「新建 → 编辑 → 保存 → 发布」的完整闭环。
 *
 * ## 409 冲突的处理（A3 的关键语义）
 * 乐观锁失败时**不清空用户输入**——显示冲突提示 + 「重新加载服务端版本」按钮，
 * 由用户决定放弃本地修改还是先手工备份。静默丢弃用户的编辑是绝对红线。
 *
 * ## 未知节点类型的处理
 * 编辑器只支持 START/APPROVAL/END。若从服务端加载到含其它类型的 schema
 * （020 交付的七型流程，或历史数据），**不允许进入编辑态**——
 * 进编辑器会让用户误以为可以保存，实际发布必被 422 拒绝。改为提示并提供只读查看。
 */
import React from 'react';
import { Alert, Button, Empty, Form, Input, List, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import {
  FlowCanvas, FlowEditor, NodePalette, ApproverEditor,
  blankSchema, editorDiagnostics, addNode, removeNode, renameNode, setApprover,
  defaultPositionFor, isEditableType, type EditableNodeType,
} from '@schema/flow-designer';
import type { ApproverRule, FlowSchema } from '@schema/schema-protocol';
import { api, ApiError, type FlowRow, type FlowDetail } from '../../shared/api';

interface EditingState {
  /** 服务端 id（新建后才有——首次保存前为 null）。 */
  id: number | null;
  /** 库里的版本（乐观锁 baseVersion）。 */
  baseVersion: number;
  schema: FlowSchema;
  /** 是否有未保存改动（离开时提示）。 */
  dirty: boolean;
}

export default function FlowTab(): React.ReactElement {
  const [rows, setRows] = React.useState<FlowRow[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [editing, setEditing] = React.useState<EditingState | null>(null);
  const [viewing, setViewing] = React.useState<FlowSchema | null>(null);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<string | null>(null);

  // 应用 id：从当前路由/上下文取（此处用 1 占位——宿主集成时由页面注入）
  const appId = 1;

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.listFlows(appId);
      setRows(resp.list);
    } catch (e) {
      setError(describeError(e));
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  React.useEffect(() => { void reload(); }, [reload]);

  // ---------- 新建 ----------

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createForm] = Form.useForm<{ flowKey: string; name: string }>();

  const handleCreate = async () => {
    const v = await createForm.validateFields();
    setSaving(true);
    try {
      const schema = blankSchema(v.flowKey, v.name);
      const created = await api.createFlow({
        appId, flowKey: v.flowKey, name: v.name, flowSchema: schema,
      });
      setCreateOpen(false);
      createForm.resetFields();
      setEditing({ id: created.id, baseVersion: 1, schema, dirty: false });
      setSelectedNodeId(null);
      await reload();
    } catch (e) {
      message.error(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  // ---------- 编辑 ----------

  const openEdit = async (row: FlowRow) => {
    setLoading(true);
    try {
      const detail = await api.getFlow(row.id);
      const schema = parseSchema(detail);
      if (schema == null) {
        setError('流程 Schema 解析失败（数据异常）');
        return;
      }
      const unsupported = schema.nodes.filter((n) => !isEditableType(String(n.type)));
      if (unsupported.length > 0) {
        // 含编辑器不支持的类型 → 只读查看，不进编辑态
        setViewing(schema);
        message.info(`该流程含 ${unsupported.length} 个暂不支持的节点类型，仅支持只读查看`);
        return;
      }
      setEditing({ id: row.id, baseVersion: detail.version, schema, dirty: false });
      setSelectedNodeId(null);
      setConflict(null);
    } catch (e) {
      message.error(describeError(e));
    } finally {
      setLoading(false);
    }
  };

  const updateSchema = (next: FlowSchema) => {
    setEditing((prev) => (prev == null ? prev : { ...prev, schema: next, dirty: true }));
  };

  // ---------- 保存 ----------

  const handleSave = async () => {
    if (editing == null) return;
    setSaving(true);
    setConflict(null);
    try {
      const resp = await api.saveFlowDraft(editing.id!, {
        flowSchema: editing.schema,
        baseVersion: editing.baseVersion,
      });
      setEditing((prev) => (prev == null ? prev : { ...prev, baseVersion: resp.version, dirty: false }));
      message.success(`草稿已保存（v${resp.version}）`);
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FLOW_VERSION_CONFLICT') {
        // A3 红线：不清空草稿——只提示冲突并给「重新加载」选项
        setConflict(`服务端版本已更新（本地基于 v${editing.baseVersion}），请重新加载后再改`);
      } else {
        message.error(describeError(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadServerVersion = async () => {
    if (editing?.id == null) return;
    await openEdit({ id: editing.id } as FlowRow);
    setConflict(null);
  };

  // ---------- 发布 ----------

  const handlePublish = async () => {
    if (editing?.id == null) return;
    const issues = editorDiagnostics(editing.schema);
    if (issues.length > 0) {
      message.error(`发布前请先修正：${issues[0]}`);
      return;
    }
    setSaving(true);
    try {
      const resp = await api.publishFlow(editing.id);
      message.success(`已发布 v${resp.version}`);
      setEditing(null);
      await reload();
    } catch (e) {
      message.error(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  // ---------- 渲染 ----------

  if (loading && rows == null) {
    return <Spin tip="加载流程列表…"><div style={{ height: 200 }} /></Spin>;
  }

  if (viewing != null) {
    return (
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space>
          <Button onClick={() => setViewing(null)}>← 返回列表</Button>
          <Typography.Text strong>{viewing.name}</Typography.Text>
          <Tag>{viewing.flowKey}</Tag>
          <Tag color="blue">v{viewing.version}</Tag>
          <Typography.Text type="secondary">只读（含暂不支持的节点类型）</Typography.Text>
        </Space>
        <FlowCanvas schema={viewing} height={520} />
      </Space>
    );
  }

  if (editing != null) {
    return (
      <EditView
        editing={editing}
        selectedNodeId={selectedNodeId}
        conflict={conflict}
        saving={saving}
        onSelect={setSelectedNodeId}
        onChange={updateSchema}
        onSave={() => void handleSave()}
        onPublish={() => void handlePublish()}
        onBack={() => {
          if (editing.dirty && !window.confirm('有未保存的改动，确定离开？')) return;
          setEditing(null);
          setConflict(null);
        }}
        onReloadServer={() => void reloadServerVersion()}
      />
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>流程</Typography.Title>
        <Space>
          <Button onClick={() => void reload()} loading={loading}>刷新</Button>
          <Button type="primary" onClick={() => setCreateOpen(true)}>新建流程</Button>
        </Space>
      </Space>

      {error != null && (
        <Alert type="error" showIcon message="加载流程列表失败" description={error}
          action={<Button size="small" onClick={() => void reload()}>重试</Button>} />
      )}

      <List
        dataSource={rows ?? []}
        locale={{ emptyText: <Empty description="暂无流程" /> }}
        renderItem={(f) => (
          <List.Item actions={[
            <Button key="edit" type="link" onClick={() => void openEdit(f)}>编辑</Button>,
          ]}>
            <List.Item.Meta
              title={<Space>
                {f.name}
                <Tag>{f.flowKey}</Tag>
                <Tag color="blue">v{f.version}</Tag>
                <Tag color={f.status === 'PUBLISHED' ? 'green' : 'default'}>{statusText(f.status)}</Tag>
              </Space>}
            />
          </List.Item>
        )}
      />

      <Modal
        title="新建流程"
        open={createOpen}
        onOk={() => void handleCreate()}
        confirmLoading={saving}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        okText="创建并编辑"
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="name" label="流程名称" rules={[{ required: true, message: '请输入流程名称' }]}>
            <Input placeholder="如：报销审批" />
          </Form.Item>
          <Form.Item
            name="flowKey"
            label="流程标识"
            rules={[
              { required: true, message: '请输入流程标识' },
              { pattern: /^[a-z][a-z0-9_-]*$/, message: '小写字母开头，可含数字/下划线/短横' },
            ]}
          >
            <Input placeholder="如：expense-approval" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

// ---------- 编辑视图 ----------

function EditView(props: {
  editing: EditingState;
  selectedNodeId: string | null;
  conflict: string | null;
  saving: boolean;
  onSelect: (id: string | null) => void;
  onChange: (next: FlowSchema) => void;
  onSave: () => void;
  onPublish: () => void;
  onBack: () => void;
  onReloadServer: () => void;
}): React.ReactElement {
  const { editing, selectedNodeId, conflict, saving } = props;
  const { schema } = editing;
  const selected = schema.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const issues = editorDiagnostics(schema);
  const hasStart = schema.nodes.some((n) => n.type === 'START');

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space>
          <Button onClick={props.onBack}>← 返回列表</Button>
          <Typography.Text strong>{schema.name}</Typography.Text>
          <Tag>{schema.flowKey}</Tag>
          <Tag color="blue">v{editing.baseVersion}</Tag>
          {editing.dirty && <Tag color="orange">未保存</Tag>}
        </Space>
        <Space>
          <Button onClick={props.onSave} loading={saving} disabled={!editing.dirty}>保存草稿</Button>
          <Button type="primary" onClick={props.onPublish} loading={saving}
            disabled={issues.length > 0}>发布</Button>
        </Space>
      </Space>

      {conflict != null && (
        <Alert type="warning" showIcon message="版本冲突" description={conflict}
          action={<Button size="small" onClick={props.onReloadServer}>重新加载服务端版本</Button>} />
      )}

      {issues.length > 0 && (
        <Alert type="info" showIcon message="发布前待修正"
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>
            {issues.map((m) => <li key={m}>{m}</li>)}
          </ul>} />
      )}

      <Space align="start" style={{ width: '100%' }} size="middle">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <NodePalette
              disableStart={hasStart}
              onAdd={(t: EditableNodeType) => {
                const next = addNode(schema, t);
                if (next === schema) {
                  message.warning(t === 'START' ? '开始节点已存在（全局唯一）' : '无法添加');
                  return;
                }
                props.onChange(next);
              }}
            />
            <FlowEditor
              value={schema}
              onChange={props.onChange}
              selectedNodeId={selectedNodeId}
              onSelectNode={props.onSelect}
              height={520}
            />
          </Space>
        </div>

        <div style={{ width: 280, flexShrink: 0 }}>
          <PropertyPanel
            schema={schema}
            selected={selected}
            onChange={props.onChange}
            onSelect={props.onSelect}
          />
        </div>
      </Space>
    </Space>
  );
}

function PropertyPanel(props: {
  schema: FlowSchema;
  selected: FlowSchema['nodes'][number] | null;
  onChange: (next: FlowSchema) => void;
  onSelect: (id: string | null) => void;
}): React.ReactElement {
  const { schema, selected, onChange } = props;
  if (selected == null) {
    return (
      <div style={{ padding: 12, border: '1px solid #f0f0f0', borderRadius: 8, color: '#8c8c8c', fontSize: 13 }}>
        选中画布节点后在此编辑属性
      </div>
    );
  }
  return (
    <div style={{ padding: 12, border: '1px solid #f0f0f0', borderRadius: 8 }}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Typography.Text strong>节点属性</Typography.Text>

        <div>
          <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>节点类型</div>
          <Tag color="blue">{selected.type}</Tag>
        </div>

        <div>
          <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>显示名称</div>
          <Input
            value={selected.name ?? ''}
            onChange={(e) => onChange(renameNode(schema, selected.id, e.target.value))}
          />
        </div>

        {selected.type === 'APPROVAL' && (
          <div>
            <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>审批人</div>
            <ApproverEditor
              value={selected.approver}
              onChange={(rule: ApproverRule) => onChange(setApprover(schema, selected.id, rule))}
            />
          </div>
        )}

        <Button danger size="small" onClick={() => {
          onChange(removeNode(schema, selected.id));
          props.onSelect(null);
        }}>删除节点</Button>
      </Space>
    </div>
  );
}

// ---------- helpers ----------

function statusText(s: string): string {
  if (s === 'PUBLISHED') return '已发布';
  if (s === 'DRAFT') return '草稿';
  return s;
}

function parseSchema(detail: FlowDetail): FlowSchema | null {
  try {
    const raw = detail.flowSchema;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj == null || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) return null;
    return {
      flowKey: String(obj.flowKey ?? detail.flowKey),
      name: String(obj.name ?? detail.name),
      version: Number(obj.version ?? detail.version),
      schemaVersion: Number(obj.schemaVersion ?? 1),
      nodes: obj.nodes,
      edges: obj.edges,
    };
  } catch {
    return null;
  }
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}：${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}