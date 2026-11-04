/**
 * M12 ER 建模器页签（10FE §1；消费 @schema/data-model-designer 协议层）：
 * - 画布：模型卡片节点（可拖拽，坐标 localStorage 草稿——视图态不入 Schema）
 * - 关系连线：SVG 直连（1:1 实线 / 1:n 燕尾箭头 / n:n 菱形标签）
 * - 字段抽屉：类型/字段名创建后禁用（后端铁律前端呈现）；ADD/MODIFY/DELETE/PROMOTE
 * - 两段式保存：precheck → 风险面板（severity 排序）→ 三档确认 → saveSchema；409/422 分态处理
 * - 版本时间线：diff 摘要 + rollback_from 标记；回滚走独立 precheck（confirmValue=模型名）
 */
import React from 'react';
import {
  Button, Checkbox, Drawer, Empty, Form, Input, List, message, Modal, Popconfirm,
  Select, Space, Spin, Tag, Timeline, Tooltip, Typography,
} from 'antd';
import { ApiError, type ApiClient, type ModelDetail, type ModelField, type ModelSummary, type PrecheckResp, type VersionRow } from './api';
import {
  buildPatch, effectiveConfirmMode, gridLayout, isRollbackNoop,
  loadLayoutDraft, saveLayoutDraft, extractRelationEdges,
  buildDraftChanges, isDuplicateFieldKey,
  type ChangeOp, type SavePhase,
} from '@schema/data-model-designer';

const TYPE_OPTIONS = [
  'text', 'number', 'date', 'enum', 'boolean', 'file', 'richtext',
  'relation', 'geo', 'user', 'dept', 'computed',
].map((t) => ({ value: t, label: t }));

const SEVERITY_COLOR: Record<string, string> = { HIGH: 'red', MEDIUM: 'orange', INFO: 'blue' };
const RISK_LABEL: Record<string, string> = {
  PAGE_REF: '页面引用', FLOW_REF: '流程引用', SCRIPT_REF: '脚本引用',
  API_CONSUMER: '外部 API 调用', DATA_VOLUME: '存量数据',
};

/** 待保存变更的编辑态模型（本地草稿——保存成功才回写服务端版本）。 */
interface DraftField extends ModelField {
  /** 本地删除标记（生成 DELETE_FIELD 变更）。 */
  _deleted?: boolean;
}

interface DraftModel {
  detail: ModelDetail;
  fields: DraftField[];
}

export default function ModelTab({ api, appId }: { api: ApiClient; appId: number }): React.ReactElement {
  const [models, setModels] = React.useState<ModelSummary[] | null>(null);
  const [details, setDetails] = React.useState<Record<string, DraftModel>>({});
  const [selected, setSelected] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DraftField | null>(null);
  const [editingIndex, setEditingIndex] = React.useState(-1);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createForm] = Form.useForm();
  const [fieldForm] = Form.useForm();
  // 画布坐标草稿（视图态）
  const [positions, setPositions] = React.useState<Record<string, { x: number; y: number }>>({});
  const dragRef = React.useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [dragTick, setDragTick] = React.useState(0);
  // 变更集（待保存）
  const [changes, setChanges] = React.useState<ChangeOp[]>([]);
  const [saving, setSaving] = React.useState(false);
  // 两段式确认弹层
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [precheck, setPrecheck] = React.useState<PrecheckResp | null>(null);
  const [effMode, setEffMode] = React.useState<'INFO' | 'CHECKBOX' | 'TYPE_MODEL_NAME'>('INFO');
  const [checkedRisks, setCheckedRisks] = React.useState<Set<number>>(new Set());
  const [modelNameInput, setModelNameInput] = React.useState('');
  // 版本时间线
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [versions, setVersions] = React.useState<VersionRow[] | null>(null);
  const [rollbackTarget, setRollbackTarget] = React.useState<number | null>(null);
  const [rollbackConfirm, setRollbackConfirm] = React.useState('');
  const [rollbackPre, setRollbackPre] = React.useState<PrecheckResp | null>(null);

  const tenantId = localStorage.getItem('schema_tenant') ?? '1';

  const loadModels = React.useCallback(async () => {
    try {
      const r = await api.listModels(appId);
      setModels(r.list);
      // 模型详情改为选中时按需加载（全量并发会把浏览器 6 连接占满——precheck 等写请求排队超时）
      // 关系边提取仅消费已加载详情（懒加载下的渐进呈现）
      // 坐标草稿：已有草稿用草稿，否则网格自动布局
      const draft = loadLayoutDraft(tenantId, appId);
      const missing = r.list.filter((m) => !draft.positions[m.id]);
      if (missing.length) {
        const auto = gridLayout(r.list);
        draft.positions = { ...draft.positions, ...Object.fromEntries(Object.entries(auto).filter(([id]) => !(id in draft.positions))) };
        saveLayoutDraft(tenantId, appId, draft);
      }
      setPositions(draft.positions);
    } catch (e) {
      handleError(e);
      setModels([]);
    }
  }, [api, appId, tenantId]);

  /** 强制重拉单个模型详情（保存/回滚后调用——懒加载缓存必须失效，否则版本号与字段集停留旧态）。 */
  const refreshDetail = React.useCallback(async (id: string) => {
    try {
      const d = await api.modelDetail(appId, id);
      setDetails((prev) => ({ ...prev, [id]: { detail: d, fields: d.fields.map((f: ModelField) => ({ ...f })) } }));
    } catch (e) {
      handleError(e);
    }
  }, [api, appId]);

  /** 选中即拉取该模型详情（单请求——画布字段数与版本号渐进呈现）。 */
  const ensureDetail = React.useCallback(async (id: string) => {
    if (details[id]) return;
    await refreshDetail(id);
  }, [details, refreshDetail]);

  /** 打开抽屉入口：选中 + 拉详情。 */
  const openDrawer = React.useCallback((id: string) => {
    setSelected(id);
    setDrawerOpen(true);
    void ensureDetail(id);
  }, [ensureDetail]);

  /** 卡片点选：选中 + 后台拉详情（不开抽屉——字段预览/版本号渐进呈现）。 */
  const openDrawerSilently = React.useCallback((id: string) => {
    setSelected(id);
    void ensureDetail(id);
  }, [ensureDetail]);

  React.useEffect(() => { void loadModels(); }, [loadModels]);

  const selectedDetail = selected ? details[selected] : null;

  /** 生成当前草稿 vs 服务端版本的变更集（纯逻辑在 protocol 包 buildDraftChanges——可单测）。 */
  const buildChanges = React.useCallback((): ChangeOp[] => {
    if (!selectedDetail) return [];
    return buildDraftChanges(selectedDetail.detail.fields, selectedDetail.fields);
  }, [selectedDetail]);

  const pendingChanges = React.useMemo(() => buildChanges(), [buildChanges]);
  const hasDelete = pendingChanges.some((c) => c.op === 'DELETE_FIELD');

  // ---------- 画布拖拽（坐标草稿） ----------

  const onCanvasMouseDown = (e: React.MouseEvent, id: string): void => {
    const pos = positions[id];
    if (!pos) return;
    dragRef.current = { id, dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.preventDefault();
    const onMove = (ev: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      setPositions((p) => ({ ...p, [d.id]: { x: Math.max(0, ev.clientX - d.dx), y: Math.max(0, ev.clientY - d.dy) } }));
      setDragTick((t) => t + 1);
    };
    const onUp = (): void => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setPositions((p) => {
        saveLayoutDraft(tenantId, appId, { positions: p });
        return p;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  React.useEffect(() => { void dragTick; }, [dragTick]);

  // ---------- 两段式保存 ----------

  const openSave = async (): Promise<void> => {
    if (!selectedDetail || !pendingChanges.length) return;
    setSaving(true);
    try {
      const pre = await api.precheck(appId, selectedDetail.detail.id, pendingChanges);
      setPrecheck(pre);
      setEffMode(effectiveConfirmMode(pre, pendingChanges));
      setCheckedRisks(new Set());
      setModelNameInput('');
      setConfirmOpen(true);
    } catch (e) {
      handleError(e);
    } finally {
      setSaving(false);
    }
  };

  /** 确认弹层提交：TYPE_MODEL_NAME 需模型名等值；CHECKBOX 需勾选全部 HIGH；含删除且无 HIGH 风险时须勾选删除确认。 */
  const canSubmitConfirm = (): boolean => {
    if (!precheck) return false;
    if (effMode === 'TYPE_MODEL_NAME') {
      return modelNameInput.trim() === (selectedDetail?.detail.name ?? '');
    }
    if (effMode === 'CHECKBOX') {
      const highIdx = precheck.risks.map((r, i) => (r.severity === 'HIGH' ? i : -1)).filter((i) => i >= 0);
      if (highIdx.length) return highIdx.every((i) => checkedRisks.has(i));
      // 含删除但无 HIGH 影响面：删除动作本身仍须显式确认（不可静默直过——every([]) 恒真的漏洞收口）
      return checkedRisks.has(DELETE_ACK_IDX);
    }
    return true;
  };

  /** 删除确认专用勾选位（不占 risks 下标——负数防冲突）。 */
  const DELETE_ACK_IDX = -1;

  const submitConfirm = async (): Promise<void> => {
    if (!selectedDetail || !precheck) return;
    setSaving(true);
    try {
      const body: { changes: ChangeOp[]; baseVersion: number; confirmToken: string; confirmValue?: string } = {
        changes: pendingChanges,
        baseVersion: selectedDetail.detail.currentVersion,
        confirmToken: precheck.confirmToken,
      };
      if (effMode === 'TYPE_MODEL_NAME') body.confirmValue = modelNameInput.trim();
      await api.saveSchema(appId, selectedDetail.detail.id, body);
      message.success(`已保存（v${selectedDetail.detail.currentVersion + 1}）`);
      setConfirmOpen(false);
      setChanges([]);
      setPrecheck(null);
      await refreshDetail(selectedDetail.detail.id);   // 缓存失效：版本号/字段集同步新态
      void loadModels();
    } catch (e) {
      // token 一次性：失败即关弹层作废，重新 precheck
      setConfirmOpen(false);
      if (e instanceof ApiError) {
        if (e.code === 'MODEL_VERSION_CONFLICT') {
          message.error(`版本冲突：他人已保存新版本（画布已刷新，请基于新版重做变更）`);
          setPrecheck(null);
          await refreshDetail(selectedDetail.detail.id);   // 本地缓存版本号过期——必须重拉
          void loadModels();
        } else if (e.code === 'CONFIRM_TOKEN_INVALID') {
          message.error('确认令牌无效或已过期——请重新预检保存');
        } else {
          message.error(e.message);
        }
      } else {
        handleError(e);
      }
    } finally {
      setSaving(false);
    }
  };

  // ---------- 版本时间线与回滚 ----------

  const openVersions = async (): Promise<void> => {
    if (!selectedDetail) return;
    setVersionsOpen(true);
    setVersions(null);
    try {
      const r = await api.listVersions(appId, selectedDetail.detail.id);
      setVersions(r.list);
    } catch (e) {
      handleError(e);
      setVersions([]);
    }
  };

  const runRollback = React.useCallback(async (target: number): Promise<void> => {
    setSaving(true);
    try {
      const pre = await api.rollbackPrecheck(appId, selectedDetail!.detail.id, target);
      // 回滚统一 TYPE_MODEL_NAME（01BE §4.3）；预检风险先呈现再提交（不静默越过高风险确认）
      setRollbackPre(pre);
    } catch (e) {
      handleError(e);
    } finally {
      setSaving(false);
    }
  }, [api, appId, selectedDetail]);

  /** 回滚确认提交（用户已看过预检风险 + 输入模型名后）。 */
  const submitRollback = async (): Promise<void> => {
    if (!selectedDetail || rollbackTarget == null || !rollbackPre) return;
    setSaving(true);
    try {
      await api.rollback(appId, selectedDetail.detail.id, {
        targetVersion: rollbackTarget,
        confirmToken: rollbackPre.confirmToken,
        confirmValue: selectedDetail.detail.name,
      });
      message.success(`已回滚到 v${rollbackTarget}（生成新版本）`);
      setVersionsOpen(false);
      setRollbackTarget(null);
      setRollbackPre(null);
      setVersions(null);
      await refreshDetail(selectedDetail.detail.id);   // 回滚后缓存失效（字段复活/重删即时呈现）
      void loadModels();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_TOKEN_INVALID') {
        message.error('回滚令牌失效——请重试');
        setRollbackPre(null);   // token 一次性：作废重检
      } else {
        handleError(e);
      }
    } finally {
      setSaving(false);
    }
  };

  // ---------- 关系边几何 ----------

  const edges = React.useMemo(() => {
    if (!models) return [];
    const withFields = models
      .filter((m) => details[m.id])
      .map((m) => ({ id: m.id, fields: details[m.id].fields.filter((f) => !f._deleted) }));
    return extractRelationEdges(withFields);
  }, [models, details]);

  const nodeCenter = (id: string): { x: number; y: number } | null => {
    const p = positions[id];
    if (!p) return null;
    return { x: p.x + 150, y: p.y + 45 };
  };

  // ---------- 渲染 ----------

  const severitySorted = React.useMemo(() => {
    if (!precheck) return [];
    const rank = { HIGH: 3, MEDIUM: 2, INFO: 1 } as const;
    return precheck.risks.map((r, i) => ({ ...r, i })).sort((a, b) => rank[b.severity] - rank[a.severity]);
  }, [precheck]);

  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" onClick={() => { createForm.resetFields(); setCreateOpen(true); }}>新建模型</Button>
        <Button disabled={!selectedDetail || !pendingChanges.length} loading={saving && !confirmOpen}
          onClick={() => { void openSave(); }}>
          保存变更{pendingChanges.length ? `（${pendingChanges.length} 项）` : ''}
        </Button>
        <Button disabled={!selectedDetail} onClick={() => { void openVersions(); }}>版本时间线</Button>
        <Button disabled={!pendingChanges.length} onClick={() => {
          // 放弃修改：详情草稿按服务端态重建（不可只刷列表——本地编辑会残留）
          setChanges([]);
          setPrecheck(null);
          if (selected) void refreshDetail(selected);
          void loadModels();
        }}>放弃修改</Button>
        {hasDelete && <Tag color="red">含删除操作</Tag>}
        <Typography.Text type="secondary">
          画布坐标仅存本地草稿（不入 Schema）；字段标识与类型创建后不可修改。
        </Typography.Text>
      </Space>

      {models === null ? (
        <div style={{ textAlign: 'center', padding: 64 }}><Spin /></div>
      ) : models.length === 0 ? (
        <Empty description="暂无模型——点击「新建模型」开始 ER 建模" />
      ) : (
        <div style={{ position: 'relative', height: 520, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa' }}>
          {/* 关系连线层 */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {edges.flatMap((e) => {
              const a = nodeCenter(e.sourceModelId);
              const b = nodeCenter(e.targetModelId);
              if (!a || !b) return [];
              return (
                <g key={e.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={e.cardinality === '1:1' ? '#595959' : '#1677ff'} strokeWidth={e.cardinality === '1:1' ? 1.5 : 1}
                    strokeDasharray={e.cardinality === 'n:n' ? '6 3' : undefined} />
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} fontSize={11} fill="#8c8c8c"
                    textAnchor="middle">{e.sourceFieldKey} · {e.cardinality}</text>
                </g>
              );
            })}
          </svg>
          {/* 模型节点层 */}
          {models.map((m) => {
            const pos = positions[m.id] ?? { x: 40, y: 40 };
            const draft = details[m.id];
            const activeCount = draft ? draft.fields.filter((f) => !f._deleted && f.fieldStatus === 'ACTIVE').length : 0;
            const dirty = draft ? draft.fields.some((f) => f._deleted || f.fieldStatus === 'DELETED') || pendingChanges.length > 0 : false;
            return (
              <div key={m.id}
                style={{
                  position: 'absolute', left: pos.x, top: pos.y, width: 300,
                  background: '#fff', border: `1px solid ${selected === m.id ? '#1677ff' : '#d9d9d9'}`,
                  borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,.06)', cursor: 'grab', zIndex: selected === m.id ? 2 : 1,
                }}
                onMouseDown={(e) => { openDrawerSilently(m.id); onCanvasMouseDown(e, m.id); }}
                onClick={() => openDrawerSilently(m.id)}
              >
                <div style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', background: selected === m.id ? '#e6f4ff' : '#fff' }}>
                  <Space>
                    <Typography.Text strong>{m.name}</Typography.Text>
                    <Tag>{m.modelKey}</Tag>
                  </Space>
                  <Tag color="blue">v{m.currentVersion}</Tag>
                </div>
                <div style={{ padding: '6px 14px 10px' }}>
                  {draft ? (
                    draft.fields.filter((f) => f.fieldStatus === 'ACTIVE').slice(0, 5).map((f) => (
                      <div key={f.fieldKey} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', opacity: f._deleted ? 0.45 : 1, textDecoration: f._deleted ? 'line-through' : 'none' }}>
                        <span>{f.label || f.fieldKey}</span>
                        <span style={{ color: '#8c8c8c' }}>{f.type}{f.required ? ' *' : ''}</span>
                      </div>
                    ))
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>加载中…</Typography.Text>
                  )}
                  {(draft?.fields.filter((f) => f.fieldStatus === 'ACTIVE').length ?? 0) > 5 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      … 共 {activeCount} 个字段
                    </Typography.Text>
                  )}
                  <Button block size="small" style={{ marginTop: 8 }}
                    onClick={(e) => { e.stopPropagation(); openDrawer(m.id); }}>
                    编辑字段
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 新建模型 */}
      <Modal title="新建模型" open={createOpen} onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const v = await createForm.validateFields();
          try {
            const r = await api.createModel(appId, v.modelKey, v.name);
            message.success(`模型已创建（v${r.currentVersion}）`);
            setCreateOpen(false);
            void loadModels();
          } catch (e) { handleError(e); }
        }}>
        <Form form={createForm} layout="vertical">
          <Form.Item name="modelKey" label="模型标识（model_key，创建后不可改）"
            rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{1,63}$/, message: '小写字母开头，2-64 位小写字母/数字/下划线' }]}>
            <Input placeholder="如 expense_report" />
          </Form.Item>
          <Form.Item name="name" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input maxLength={128} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 字段编辑抽屉 */}
      <Drawer title={`${selectedDetail?.detail.name ?? ''} · 字段编辑`} width={480} open={drawerOpen && !!selectedDetail}
        onClose={() => { setDrawerOpen(false); setEditing(null); }}>
        {selectedDetail && (
          <>
            <Space style={{ marginBottom: 12 }}>
              <Button size="small" onClick={() => {
                setEditing(null);
                setEditingIndex(-1);
                fieldForm.resetFields();
                setEditing({ placeholder: 'new' } as unknown as DraftField);
              }}>新增字段</Button>
              <Typography.Text type="secondary">
                字段标识/类型创建后不可改；删除走软删（保存时强制高规格确认）。
              </Typography.Text>
            </Space>
            {editing && (
              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fafafa' }}>
                <Typography.Text strong>{editingIndex >= 0 ? `修改字段：${selectedDetail.fields[editingIndex].fieldKey}` : '新增字段'}</Typography.Text>
                <Form form={fieldForm} layout="vertical" style={{ marginTop: 8 }}
                  initialValues={editingIndex >= 0 ? {
                    label: selectedDetail.fields[editingIndex].label,
                    type: selectedDetail.fields[editingIndex].type,
                    required: selectedDetail.fields[editingIndex].required,
                  } : undefined}>
                  {editingIndex < 0 && (
                    <>
                      <Form.Item name="fieldKey" label="字段标识（field_key）"
                        rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{0,63}$/, message: '小写字母开头' }]}>
                        <Input placeholder="如 amount" />
                      </Form.Item>
                      <Form.Item name="type" label="字段类型（12 种冻结枚举）" rules={[{ required: true }]}>
                        <Select options={TYPE_OPTIONS} />
                      </Form.Item>
                    </>
                  )}
                  {editingIndex >= 0 && (
                    <>
                      <Form.Item label="字段标识">
                        <Input disabled value={selectedDetail.fields[editingIndex].fieldKey} />
                      </Form.Item>
                      <Form.Item label="字段类型">
                        <Select disabled value={selectedDetail.fields[editingIndex].type} options={TYPE_OPTIONS} />
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
                    const curType = editingIndex >= 0 ? selectedDetail.fields[editingIndex].type : fieldForm.getFieldValue('type') as string | undefined;
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
                            <Select options={[
                              { value: '1:1', label: '1:1 一对一' },
                              { value: '1:n', label: '1:n 一对多' },
                              { value: 'n:n', label: 'n:n 多对多' },
                            ]} />
                          </Form.Item>
                          <Form.Item name={['relation', 'cascade']} label="级联策略" initialValue="FORBID"
                            rules={[{ required: true }]}>
                            <Select options={[
                              { value: 'FORBID', label: 'FORBID 禁止删除' },
                              { value: 'SET_NULL', label: 'SET_NULL 置空' },
                              { value: 'CASCADE', label: 'CASCADE 级联' },
                            ]} />
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
                            <Select options={[
                              { value: 'READ_TIME', label: 'READ_TIME 读时计算' },
                              { value: 'ON_WRITE', label: 'ON_WRITE 写时物化' },
                            ]} />
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
                      if (typeof v.type === 'string' ? v.type === 'enum' : editingIndex >= 0 && selectedDetail.fields[editingIndex].type === 'enum') {
                        const lines = String(v.enumOptionsStr ?? '').split('\n').filter((l) => l.trim());
                        if (lines.length) {
                          out.enumOptions = lines.map((l) => {
                            const [value, label] = l.trim().split('|');
                            return { value, label, status: 'ACTIVE' };
                          });
                        }
                      }
                      if (typeof v.type === 'string' ? v.type === 'relation' : editingIndex >= 0 && selectedDetail.fields[editingIndex].type === 'relation') {
                        if (v.relation?.targetModelId) {
                          out.relation = {
                            targetModelId: String(v.relation.targetModelId),
                            cardinality: String(v.relation.cardinality ?? '1:n'),
                            cascade: String(v.relation.cascade ?? 'FORBID'),
                          };
                        }
                      }
                      if (typeof v.type === 'string' ? v.type === 'computed' : editingIndex >= 0 && selectedDetail.fields[editingIndex].type === 'computed') {
                        if (v.computed?.expr?.source) {
                          out.computed = {
                            expr: { kind: 'expr', source: String(v.computed.expr.source) },
                            dependsOn: String(v.computed.dependsOn ?? '').split(',').map((s) => s.trim()).filter(Boolean),
                            persistMode: String(v.computed.persistMode ?? 'READ_TIME'),
                          };
                        }
                      }
                      return out;
                    };
                    if (editingIndex >= 0) {
                      const next = [...selectedDetail.fields];
                      next[editingIndex] = { ...next[editingIndex], label: v.label, required: !!v.required, ...parseConfigs() };
                      setDetails((d) => ({ ...d, [selected!]: { ...d[selected!], fields: next } }));
                    } else {
                      // 本地重名前置阻断（服务端 FIELD_KEY_DUPLICATED 兜底——提前给出可定位的错误）
                      const key = String(v.fieldKey ?? '');
                      if (isDuplicateFieldKey(selectedDetail.fields, key)) {
                        message.error(`字段标识 ${key} 已存在（含本地新增与软删历史）`);
                        return;
                      }
                      const newField: DraftField = {
                        fieldKey: v.fieldKey, label: v.label, type: v.type, fieldStatus: 'ACTIVE',
                        required: !!v.required, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: selectedDetail.fields.length + 1,
                        ...parseConfigs(),
                      };
                      setDetails((d) => ({ ...d, [selected!]: { ...d[selected!], fields: [...d[selected!].fields, newField] } }));
                    }
                    setEditing(null);
                    setEditingIndex(-1);
                  }}>应用</Button>
                  <Button size="small" onClick={() => { setEditing(null); setEditingIndex(-1); }}>取消</Button>
                </Space>
              </div>
            )}
            <List
              size="small"
              dataSource={selectedDetail.fields.map((f, i) => ({ f, i }))}
              renderItem={({ f, i }) => (
                <List.Item
                  style={{ opacity: f._deleted ? 0.45 : 1 }}
                  actions={f.fieldStatus !== 'ACTIVE' ? [] : ([
                    <Button key="edit" size="small" type="link" disabled={!!f._deleted}
                      onClick={() => {
                        setEditingIndex(i);
                        setEditing(f);
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
                        setDetails((d) => {
                          const next = [...d[selected!].fields];
                          next[i] = { ...next[i], _deleted: false };
                          return { ...d, [selected!]: { ...d[selected!], fields: next } };
                        });
                      }}>撤销</Button>
                    ) : (
                      <Popconfirm key="del" title="删除该字段？（保存时强制勾选确认）" onConfirm={() => {
                        setDetails((d) => {
                          const next = [...d[selected!].fields];
                          next[i] = { ...next[i], _deleted: true };
                          return { ...d, [selected!]: { ...d[selected!], fields: next } };
                        });
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

      {/* 两段式确认弹层：左变更清单 + 右影响面（severity 排序） */}
      <Modal title={`保存确认 · ${selectedDetail?.detail.name ?? ''}`} open={confirmOpen} width={720}
        onCancel={() => setConfirmOpen(false)}
        okText={effMode === 'TYPE_MODEL_NAME' ? '输入模型名后确认' : '确认保存'}
        okButtonProps={{ danger: hasDelete, disabled: !canSubmitConfirm(), loading: saving }}
        onOk={() => { void submitConfirm(); }}>
        {precheck && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <Typography.Text strong>变更清单（{pendingChanges.length} 项）</Typography.Text>
              <List size="small" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}
                dataSource={pendingChanges}
                renderItem={(c) => (
                  <List.Item style={{ padding: '4px 0' }}>
                    <Space>
                      <Tag color={c.op === 'DELETE_FIELD' ? 'red' : c.op === 'ADD_FIELD' ? 'green' : 'blue'}>
                        {c.op === 'ADD_FIELD' ? '新增' : c.op === 'MODIFY_FIELD' ? '修改' : c.op === 'DELETE_FIELD' ? '删除' : '提升列'}
                      </Tag>
                      <span>{c.fieldKey}</span>
                      {c.op === 'MODIFY_FIELD' && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {Object.keys(c.patch).join(', ')}
                        </Typography.Text>
                      )}
                    </Space>
                  </List.Item>
                )} />
            </div>
            <div>
              <Typography.Text strong>影响面（{severitySorted.length} 项，按严重度排序）</Typography.Text>
              <List size="small" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}
                locale={{ emptyText: '无风险项' }}
                dataSource={severitySorted}
                renderItem={(r) => (
                  <List.Item style={{ padding: '4px 0' }}
                    actions={effMode === 'CHECKBOX' && r.severity === 'HIGH' ? ([
                      <Checkbox key="ack" checked={checkedRisks.has(r.i)} onChange={(e) => {
                        setCheckedRisks((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(r.i); else next.delete(r.i);
                          return next;
                        });
                      }}>我已了解</Checkbox>,
                    ]) : []}>
                    <Space>
                      <Tag color={SEVERITY_COLOR[r.severity]}>{r.severity}</Tag>
                      <span>{RISK_LABEL[r.type] ?? r.type}</span>
                      {r.refName && <Typography.Text type="secondary">{r.refName}</Typography.Text>}
                      {r.type === 'DATA_VOLUME' && <Typography.Text type="secondary">{r.count} 行</Typography.Text>}
                      {r.type === 'API_CONSUMER' && <Typography.Text type="secondary">{r.keyName} · 近30天 {r.calls30d} 次</Typography.Text>}
                    </Space>
                  </List.Item>
                )} />
            </div>
          </div>
        )}
        {effMode === 'TYPE_MODEL_NAME' && (
          <div style={{ marginTop: 16 }}>
            <Typography.Paragraph type="danger">
              高风险操作：请输入完整模型名 <Typography.Text code>{selectedDetail?.detail.name}</Typography.Text> 确认保存。
            </Typography.Paragraph>
            <Input value={modelNameInput} onChange={(e) => setModelNameInput(e.target.value)}
              placeholder={selectedDetail?.detail.name} />
          </div>
        )}
        {effMode === 'CHECKBOX' && (
          <>
            <Typography.Paragraph type="warning" style={{ marginTop: 12 }}>
              含删除操作：须逐条确认全部 HIGH 风险后方可保存（删除字段为软删，可通过版本回滚恢复）。
            </Typography.Paragraph>
            {hasDelete && !severitySorted.some((r) => r.severity === 'HIGH') && (
              <Space style={{ marginTop: 4 }}>
                <Checkbox checked={checkedRisks.has(DELETE_ACK_IDX)} onChange={(e) => {
                  setCheckedRisks((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(DELETE_ACK_IDX); else next.delete(DELETE_ACK_IDX);
                    return next;
                  });
                }}>
                  我确认删除上述字段（当前无 HIGH 级影响面，删除仍不可撤销——仅可回滚）
                </Checkbox>
              </Space>
            )}
          </>
        )}
      </Modal>

      {/* 版本时间线与回滚 */}
      <Drawer title={`版本时间线 · ${selectedDetail?.detail.name ?? ''}`} width={440} open={versionsOpen}
        onClose={() => { setVersionsOpen(false); setRollbackTarget(null); }}>
        {versions === null ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
        ) : (
          <>
            <Timeline
              items={versions.map((v) => ({
                color: v.rollbackFrom != null ? 'orange' : 'green',
                children: (
                  <div>
                    <Space>
                      <Typography.Text strong>v{v.version}</Typography.Text>
                      {v.rollbackFrom != null && <Tag color="orange">回滚自 v{v.rollbackFrom}</Tag>}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {v.createdAt ?? ''} · 操作者 {v.operator}
                      </Typography.Text>
                    </Space>
                    <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>
                      {(v.diffSummary ?? []).map((d, i) => `${d.op === 'ADD_FIELD' ? '+' : d.op === 'DELETE_FIELD' ? '-' : d.op === 'RESURRECT_FIELD' ? '↺' : '~'}${d.fieldKey}`).join('  ') || '（初始版本）'}
                    </div>
                    {selectedDetail && v.version !== selectedDetail.detail.currentVersion && (
                      <Button size="small" danger style={{ marginTop: 6 }}
                        onClick={() => { setRollbackTarget(v.version); setRollbackConfirm(''); setRollbackPre(null); void runRollback(v.version); }}>
                        回滚到此版本
                      </Button>
                    )}
                  </div>
                ),
              }))}
            />
            <Modal title={`回滚确认 · 目标 v${rollbackTarget ?? ''}`} open={rollbackTarget != null}
              onCancel={() => { setRollbackTarget(null); setRollbackPre(null); }}
              okText="确认回滚" okButtonProps={{ danger: true, disabled: rollbackConfirm.trim() !== (selectedDetail?.detail.name ?? '\0') || !rollbackPre, loading: saving }}
              onOk={() => { void submitRollback(); }}>
              {/* 预检影响面先呈现（无风险也显式说明），用户知情后再输入模型名 */}
              {rollbackPre ? (
                <div style={{ marginBottom: 12 }}>
                  <Typography.Text strong>回滚影响面（{rollbackPre.risks.length} 项）</Typography.Text>
                  <List size="small" style={{ marginTop: 4, maxHeight: 160, overflow: 'auto' }}
                    locale={{ emptyText: '无风险项（字段定义还原，数据零操作）' }}
                    dataSource={rollbackPre.risks}
                    renderItem={(r) => (
                      <List.Item style={{ padding: '2px 0' }}>
                        <Space>
                          <Tag color={SEVERITY_COLOR[r.severity]}>{r.severity}</Tag>
                          <span>{RISK_LABEL[r.type] ?? r.type}</span>
                          {r.refName && <Typography.Text type="secondary">{r.refName}</Typography.Text>}
                        </Space>
                      </List.Item>
                    )} />
                </div>
              ) : (
                <Typography.Text type="secondary">正在获取回滚影响面…</Typography.Text>
              )}
              <Typography.Paragraph type="danger">
                回滚将以新版本形式还原 v{rollbackTarget} 的字段定义（数据零操作）；
                此后版本的字段变更将被覆盖。请输入完整模型名 <Typography.Text code>{selectedDetail?.detail.name}</Typography.Text> 确认。
              </Typography.Paragraph>
              <Input value={rollbackConfirm} onChange={(e) => setRollbackConfirm(e.target.value)}
                placeholder={selectedDetail?.detail.name} />
            </Modal>
          </>
        )}
      </Drawer>
    </>
  );
}

function handleError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  message.error(msg);
}
