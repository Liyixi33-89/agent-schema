/**
 * ER 建模器字段编辑抽屉（10FE §1——自 ModelTab.tsx 原样抽出，行为不变）：
 * - 字段列表：ADD/MODIFY/DELETE/PROMOTE 操作；字段标识/类型创建后禁改（后端铁律前端呈现）
 * - 编辑表单：类型相关配置（enum/relation/computed）按选中类型受控渲染（表单块与解析
 *   已抽至 fieldConfigForms.tsx——本文件收敛为抽屉编排与字段列表）
 * - 表单值 → 字段配置解析与本地重名前置阻断
 */
import React from 'react';
import {
  Button, Checkbox, Drawer, Form, Input, List, message, Popconfirm, Select, Space, Tag, Typography,
} from 'antd';
import type { ModelSummary } from '../../shared/api';
import { isDuplicateFieldKey } from '@schema/data-model-designer';
import { TYPE_OPTIONS, type DraftField, type DraftModel } from './modelTabShared';
import { TypeConfigForm, parseFieldConfigs } from './fieldConfigForms';

export interface FieldEditorDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 当前选中模型编辑态（null=详情未就绪——抽屉由父级控制开态）。 */
  draft: DraftModel | null;
  /** 加载失败态（error 态也开——失败可见可重试）。 */
  loadError: boolean;
  /** 重试加载详情。 */
  onRetry: () => void;
  /** 应用模型清单（relation 目标下拉）。 */
  models: ModelSummary[] | null;
  /** 字段集变更（本地草稿回写父级 details）。 */
  onFieldsChange: (fields: DraftField[]) => void;
  /** 关联字段预填（画布连线场景——表单打开即带 relation 配置）。 */
  presetRelation?: { targetModelId: string } | null;
}

export default function FieldEditorDrawer({
  open, onClose, draft, loadError, onRetry, models, onFieldsChange, presetRelation,
}: FieldEditorDrawerProps): React.ReactElement {
  const [editing, setEditing] = React.useState<DraftField | null>(null);
  const [editingIndex, setEditingIndex] = React.useState(-1);
  /** 新增场景受控类型（配置表单渲染驱动——fieldForm.getFieldValue 不触发重渲染）。 */
  const [editingType, setEditingType] = React.useState<string | undefined>(undefined);
  const [fieldForm] = Form.useForm();

  // 连线预填：抽屉打开且携带 presetRelation 时进入新增 relation 表单
  React.useEffect(() => {
    if (!open || !presetRelation) return;
    setEditing({ placeholder: 'new' } as unknown as DraftField);
    setEditingIndex(-1);
    setEditingType('relation');   // 受控类型同步（连线预填场景）
    fieldForm.resetFields();
    fieldForm.setFieldsValue({ type: 'relation', relation: { targetModelId: presetRelation.targetModelId, cardinality: '1:n', cascade: 'FORBID' } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetRelation]);

  const title = `${draft?.detail.name ?? ''} · 字段编辑`;

  return (
    <Drawer title={title} width={480}
      open={open && (!!draft || loadError)}
      destroyOnClose
      onClose={() => { onClose(); setEditing(null); }}>
      {loadError && !draft && (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Typography.Text type="danger">详情加载失败——本地无数据缓存，请重试。</Typography.Text>
          <div style={{ marginTop: 16 }}>
            <Button type="primary" onClick={onRetry}>重试加载</Button>
            <Button style={{ marginLeft: 8 }} onClick={onClose}>关闭</Button>
          </div>
        </div>
      )}
      {draft && (
        <>
          <Space style={{ marginBottom: 12 }}>
            <Button size="small" onClick={() => {
              setEditing(null);
              setEditingIndex(-1);
              setEditingType(undefined);
              fieldForm.resetFields();
              setEditing({ placeholder: 'new' } as unknown as DraftField);
            }}>新增字段</Button>
            <Typography.Text type="secondary">
              字段标识/类型创建后不可改；删除走软删（保存时强制高规格确认）。
            </Typography.Text>
          </Space>
          {editing && (
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fafafa' }}>
              <Typography.Text strong>{editingIndex >= 0 ? `修改字段：${draft.fields[editingIndex].fieldKey}` : '新增字段'}</Typography.Text>
              <Form form={fieldForm} layout="vertical" style={{ marginTop: 8 }}
                initialValues={editingIndex >= 0 ? {
                  label: draft.fields[editingIndex].label,
                  type: draft.fields[editingIndex].type,
                  required: draft.fields[editingIndex].required,
                } : undefined}>
                {editingIndex < 0 && (
                  <>
                    <Form.Item name="fieldKey" label="字段标识（field_key）"
                      rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{0,63}$/, message: '小写字母开头' }]}>
                      <Input placeholder="如 amount" />
                    </Form.Item>
                    <Form.Item name="type" label="字段类型（12 种冻结枚举）" rules={[{ required: true }]}>
                      <Select options={TYPE_OPTIONS} onChange={(newType) => {
                        // 类型切换清理：不适用配置的旧表单值必须清除（防残留误发——后端 FIELD_CONFIG_INVALID 兜底）
                        const prev = editingType;
                        if (prev && prev !== newType) {
                          fieldForm.setFieldsValue({ enumOptionsStr: undefined, relation: undefined, computed: undefined });
                        }
                        setEditingType(newType as string);   // 受控驱动配置表单渲染（getFieldValue 不触发重渲染——配置表单永不出现的缺陷）
                      }} />
                    </Form.Item>
                  </>
                )}
                {editingIndex >= 0 && (
                  <>
                    <Form.Item label="字段标识">
                      <Input disabled value={draft.fields[editingIndex].fieldKey} />
                    </Form.Item>
                    <Form.Item label="字段类型">
                      <Select disabled value={draft.fields[editingIndex].type} options={TYPE_OPTIONS} />
                    </Form.Item>
                  </>
                )}
                <Form.Item name="label" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
                  <Input maxLength={128} />
                </Form.Item>
                <Form.Item name="required" valuePropName="checked" label="必填">
                  <Checkbox />
                </Form.Item>
                <TypeConfigForm
                  curType={(editingIndex >= 0 ? draft.fields[editingIndex].type : editingType) ?? ''}
                  models={models}
                />
              </Form>
              <Space>
                <Button type="primary" size="small" onClick={async () => {
                  const v = await fieldForm.validateFields();
                  const curType = editingIndex >= 0 ? draft.fields[editingIndex].type : editingType;
                  const configs = parseFieldConfigs(v, curType);
                  if (editingIndex >= 0) {
                    const next = [...draft.fields];
                    next[editingIndex] = { ...next[editingIndex], label: v.label, required: !!v.required, ...configs };
                    onFieldsChange(next);
                  } else {
                    // 本地重名前置阻断（服务端 FIELD_KEY_DUPLICATED 兜底——提前给出可定位的错误）
                    const key = String(v.fieldKey ?? '');
                    if (isDuplicateFieldKey(draft.fields, key)) {
                      message.error(`字段标识 ${key} 已存在（含本地新增与软删历史）`);
                      return;
                    }
                    const newField: DraftField = {
                      fieldKey: v.fieldKey, label: v.label, type: v.type, fieldStatus: 'ACTIVE',
                      required: !!v.required, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: draft.fields.length + 1,
                      ...configs,
                    };
                    onFieldsChange([...draft.fields, newField]);
                  }
                  setEditing(null);
                  setEditingIndex(-1);
                }}>应用</Button>
                <Button size="small" onClick={() => { setEditing(null); setEditingIndex(-1); setEditingType(undefined); }}>取消</Button>
              </Space>
            </div>
          )}
          <List
            size="small"
            dataSource={draft.fields.map((f, i) => ({ f, i }))}
            renderItem={({ f, i }) => (
              <List.Item
                style={{ opacity: f._deleted ? 0.45 : 1 }}
                actions={f.fieldStatus !== 'ACTIVE' ? [] : ([
                  <Button key="edit" size="small" type="link" disabled={!!f._deleted}
                    onClick={() => {
                      setEditingIndex(i);
                      setEditing(f);
                      setEditingType(f.type);   // 受控类型同步（修改场景——配置表单按字段类型渲染）
                      fieldForm.setFieldsValue({
                        label: f.label, required: f.required,
                        ...(f.type === 'enum' && f.enumOptions ? {
                          enumOptionsStr: f.enumOptions.map((o) => `${o.value}|${o.label}`).join('\n'),
                        } : {}),
                        ...(f.type === 'relation' && f.relation ? {
                          relation: { targetModelId: f.relation.targetModelId, cardinality: f.relation.cardinality, cascade: f.relation.cascade },
                        } : {}),
                        ...(f.type === 'computed' && f.computed ? {
                          computed: {
                            expr: { source: f.computed.expr.source },
                            dependsOn: f.computed.dependsOn.join(','),
                            persistMode: f.computed.persistMode,
                          },
                        } : {}),
                      });
                    }}>修改</Button>,
                  f._deleted ? (
                    <Button key="undo" size="small" type="link" onClick={() => {
                      const next = [...draft.fields];
                      next[i] = { ...next[i], _deleted: false };
                      onFieldsChange(next);
                    }}>撤销</Button>
                  ) : (
                    <Popconfirm key="del" title="删除该字段？（保存时强制勾选确认）" onConfirm={() => {
                      const next = [...draft.fields];
                      next[i] = { ...next[i], _deleted: true };
                      onFieldsChange(next);
                    }}>
                      <Button size="small" type="link" danger>删除</Button>
                    </Popconfirm>
                  ),
                ])}
              >
                <Space>
                  <Typography.Text delete={!!f._deleted}>{f.label}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{f.fieldKey}</Typography.Text>
                  <Tag style={{ fontSize: 11 }}>{f.type}</Tag>
                  {f.required && <Tag color="red" style={{ fontSize: 11 }}>必填</Tag>}
                  {f.fieldStatus === 'DELETED' && <Tag color="default">已删除（历史）</Tag>}
                </Space>
              </List.Item>
            )}
          />
        </>
      )}
    </Drawer>
  );
}
