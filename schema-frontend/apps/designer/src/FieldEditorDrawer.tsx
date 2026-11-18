/**
 * ER 建模器字段编辑抽屉（10FE §1——自 ModelTab.tsx 原样抽出，行为不变）：
 * - 字段列表：ADD/MODIFY/DELETE/PROMOTE 操作；字段标识/类型创建后禁改（后端铁律前端呈现）
 * - 编辑表单：类型相关配置（enum/relation/computed）按选中类型受控渲染
 * - 表单值 → 字段配置解析（parseConfigs）与本地重名前置阻断
 */
import React from 'react';
import {
  Button, Checkbox, Drawer, Form, Input, List, message, Popconfirm, Select, Space, Tag, Typography,
} from 'antd';
import type { ModelSummary } from './api';
import {
  isDuplicateFieldKey,
  RELATION_CARDINALITIES, RELATION_CASCADES, COMPUTED_PERSIST_MODES,
} from '@schema/data-model-designer';
import { TYPE_OPTIONS, type DraftField, type DraftModel } from './modelTabShared';

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
                {/* 类型相关配置（01BE §4.2 步骤 4：enum→enumOptions / relation→目标+基数+级联 / computed→表达式+依赖） */}
                {(() => {
                  const curType = editingIndex >= 0 ? draft.fields[editingIndex].type : editingType;
                  if (!curType) return null;
                  if (curType === 'enum') {
                    return (
                      <Form.Item name="enumOptionsStr" label="枚举选项（每行 value|label，value 不可重复）"
                        rules={[{
                          validator: (_: unknown, value: string) => {
                            if (!value?.trim()) return Promise.resolve();
                            const seen = new Set<string>();
                            for (const line of value.split('\n')) {
                              const parts = line.trim().split('|');
                              if (parts.length !== 2 || !parts[0] || !parts[1]) return Promise.reject(new Error('格式：value|label'));
                              if (seen.has(parts[0])) return Promise.reject(new Error(`value 重复：${parts[0]}`));
                              seen.add(parts[0]);
                            }
                            return Promise.resolve();
                          },
                        }]}>
                        <Input.TextArea rows={3} placeholder={'draft|草稿\napproved|已审批'} />
                      </Form.Item>
                    );
                  }
                  if (curType === 'relation') {
                    return (
                      <>
                        <Form.Item name={['relation', 'targetModelId']} label="关联目标模型"
                          rules={[{ required: true, message: '请选择目标模型' }]}>
                          <Select options={models?.filter((mm) => mm.status === 'ACTIVE').map((mm) => ({ value: mm.id, label: `${mm.name}（${mm.modelKey}）` })) ?? []} />
                        </Form.Item>
                        <Form.Item name={['relation', 'cardinality']} label="基数" initialValue="1:n"
                          rules={[{ required: true }]}>
                          <Select options={RELATION_CARDINALITIES.map((c) => ({
                            value: c,
                            label: c === '1:1' ? '1:1 一对一' : c === '1:n' ? '1:n 一对多' : 'n:n 多对多',
                          }))} />
                        </Form.Item>
                        <Form.Item name={['relation', 'cascade']} label="级联策略" initialValue="FORBID"
                          rules={[{ required: true }]}>
                          <Select options={RELATION_CASCADES.map((c) => ({
                            value: c,
                            label: c === 'FORBID' ? 'FORBID 禁止删除' : c === 'SET_NULL' ? 'SET_NULL 置空' : 'CASCADE_SOFT_DELETE 级联软删',
                          }))} />
                        </Form.Item>
                      </>
                    );
                  }
                  if (curType === 'computed') {
                    return (
                      <>
                        <Form.Item name={['computed', 'expr', 'source']} label="计算表达式（白名单表达式，如 amount * 2）"
                          rules={[{ required: true, message: '请输入表达式' }]}>
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item name={['computed', 'dependsOn']} label="依赖字段（逗号分隔）"
                          rules={[{ required: true, message: '请填写依赖字段' }]}>
                          <Input placeholder="amount, rate" />
                        </Form.Item>
                        <Form.Item name={['computed', 'persistMode']} label="持久化模式" initialValue="READ_TIME" rules={[{ required: true }]}>
                          <Select options={COMPUTED_PERSIST_MODES.map((m) => ({
                            value: m,
                            label: m === 'READ_TIME' ? 'READ_TIME 读时计算' : 'PERSISTED 写时物化',
                          }))} />
                        </Form.Item>
                      </>
                    );
                  }
                  return null;
                })()}
              </Form>
              <Space>
                <Button type="primary" size="small" onClick={async () => {
                  const v = await fieldForm.validateFields();
                  /** 表单值 → 字段配置（enum/relation/computed；enumOptionsStr 文本按行解析）。 */
                  const parseConfigs = (): Pick<DraftField, 'enumOptions' | 'relation' | 'computed'> => {
                    const out: Pick<DraftField, 'enumOptions' | 'relation' | 'computed'> = {};
                    if (typeof v.type === 'string' ? v.type === 'enum' : editingIndex >= 0 && draft.fields[editingIndex].type === 'enum') {
                      const lines = String(v.enumOptionsStr ?? '').split('\n').filter((l) => l.trim());
                      if (lines.length) {
                        out.enumOptions = lines.map((l) => {
                          const [value, label] = l.trim().split('|');
                          return { value, label, status: 'ACTIVE' };
                        });
                      }
                    }
                    if (typeof v.type === 'string' ? v.type === 'relation' : editingIndex >= 0 && draft.fields[editingIndex].type === 'relation') {
                      if (v.relation?.targetModelId) {
                        out.relation = {
                          targetModelId: String(v.relation.targetModelId),
                          cardinality: RELATION_CARDINALITIES.includes(v.relation.cardinality) ? v.relation.cardinality : '1:n',
                          cascade: RELATION_CASCADES.includes(v.relation.cascade) ? v.relation.cascade : 'FORBID',
                        };
                      }
                    }
                    if (typeof v.type === 'string' ? v.type === 'computed' : editingIndex >= 0 && draft.fields[editingIndex].type === 'computed') {
                      if (v.computed?.expr?.source) {
                        out.computed = {
                          expr: { kind: 'expr', source: String(v.computed.expr.source) },
                          dependsOn: String(v.computed.dependsOn ?? '').split(',').map((s) => s.trim()).filter(Boolean),
                          persistMode: COMPUTED_PERSIST_MODES.includes(v.computed.persistMode) ? v.computed.persistMode : 'READ_TIME',
                        };
                      }
                    }
                    return out;
                  };
                  if (editingIndex >= 0) {
                    const next = [...draft.fields];
                    next[editingIndex] = { ...next[editingIndex], label: v.label, required: !!v.required, ...parseConfigs() };
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
                      ...parseConfigs(),
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
