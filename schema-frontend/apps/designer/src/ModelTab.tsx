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
import ErCanvas from './ErCanvas';
import {
  buildPatch, effectiveConfirmMode, gridLayout, layeredLayout, isRollbackNoop,
  loadLayoutDraft, saveLayoutDraft, extractRelationEdges,
  buildDraftChanges, buildConflictRows, adoptServerDraft, isDuplicateFieldKey,
  RELATION_CARDINALITIES, RELATION_CASCADES, COMPUTED_PERSIST_MODES,
  type ChangeOp, type ConflictRow, type SavePhase,
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
  /** 编辑基线（加载时快照）——409 三方对比的合并起点；与服务端 detail 分离。 */
  baseFields: ModelField[];
}

/** 详情加载状态：null=未加载；'loading' 进行中；失败标记便于重试。 */
type DetailState = DraftModel | 'loading' | 'error';

export default function ModelTab({ api, appId }: { api: ApiClient; appId: number }): React.ReactElement {
  const [models, setModels] = React.useState<ModelSummary[] | null>(null);
  const [details, setDetails] = React.useState<Record<string, DetailState>>({});
  const [selected, setSelected] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DraftField | null>(null);
  const [editingIndex, setEditingIndex] = React.useState(-1);
  /** 新增场景受控类型（配置表单渲染驱动——fieldForm.getFieldValue 不触发重渲染）。 */
  const [editingType, setEditingType] = React.useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createForm] = Form.useForm();
  const [fieldForm] = Form.useForm();
  // 画布坐标草稿（视图态）
  const [positions, setPositions] = React.useState<Record<string, { x: number; y: number }>>({});
  /** 画布重挂载纪元（坐标批量重排后递增——React Flow 全量重建节点时 Handle 测量竞态
   *  会让边渲染被永久跳过，重挂载触发全新测量）。 */
  const [canvasEpoch, setCanvasEpoch] = React.useState(0);
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
  // 409 冲突对比弹层（10FE §1.3 ⑥）：本地草稿保留，用户显式裁决后处理
  const [conflictOpen, setConflictOpen] = React.useState(false);
  const [conflictRows, setConflictRows] = React.useState<ConflictRow[]>([]);
  const [conflictServer, setConflictServer] = React.useState<ModelDetail | null>(null);
  // 版本时间线
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [versions, setVersions] = React.useState<VersionRow[] | null>(null);
  const [rollbackTarget, setRollbackTarget] = React.useState<number | null>(null);
  const [rollbackConfirm, setRollbackConfirm] = React.useState('');
  const [rollbackPre, setRollbackPre] = React.useState<PrecheckResp | null>(null);

  const tenantId = localStorage.getItem('schema_tenant') ?? '1';
  /** 画布坐标合理域上限——超出视为旧草稿退化（单行超宽），自动重排（视图态非业务数据）。 */
  const CANVAS_LIMIT = 8000;
  // 请求序号（异步一致性）：切换模型/应用后旧响应晚到不得覆盖新选中对象的编辑态
  const reqSeqRef = React.useRef(0);
  const inflightRef = React.useRef(0);
  const LOAD_CONCURRENCY = 3;

  const loadModels = React.useCallback(async () => {
    try {
      const r = await api.listModels(appId);
      setModels(r.list);
      // 草稿持久化两段式：
      // 1) 此处仅补「缺失坐标」的内存占位（退化布局，不落盘）——关系数据未加载，
      //    此时落盘会把退化单行固化，后续关系驱动重排又被「坐标已存在」跳过；
      // 2) loadAllDetails 完成后按真实关系分层重排才持久化（见 loadAllDetails）。
      // 旧自实现画布的漂移草稿（clientX 数万像素）同样留给重排兜底按域清理。
      const draft = loadLayoutDraft(tenantId, appId);
      const known = new Set(Object.keys(draft.positions));
      const missing = r.list.filter((m) => !known.has(m.id));
      if (missing.length) {
        const auto = layeredLayout(r.list, []);
        draft.positions = { ...draft.positions, ...Object.fromEntries(Object.entries(auto).filter(([id]) => !(id in draft.positions))) };
      }
      setPositions(draft.positions);
    } catch (e) {
      handleError(e);
      setModels([]);
    }
  }, [api, appId, tenantId]);

  /**
   * 强制重拉单个模型详情（保存/回滚/放弃后调用——懒加载缓存必须失效，否则版本号与字段集停留旧态）。
   * opts.background=true：批量后台加载路径——不参与请求序号竞争（否则批量请求互相判旧全部丢弃）；
   * 仅用户主动加载（选中/保存后刷新）记录 seq，用于旧响应晚到时不覆盖新选中对象的编辑态。
   */
  const refreshDetail = React.useCallback(async (id: string, opts?: { background?: boolean }): Promise<ModelDetail | null> => {
    const background = !!opts?.background;
    const seq = background ? 0 : ++reqSeqRef.current;
    setDetails((prev) => ({ ...prev, [id]: prev[id] ?? 'loading' }));
    try {
      const d = await api.modelDetail(appId, id);
      if (!background && seq !== reqSeqRef.current && selectedRef.current !== id) return null;   // 旧响应晚到：不覆盖当前编辑对象
      setDetails((prev) => ({
        ...prev,
        // 服务端 DELETED 字段带 _deleted 标记——否则 diff 会把「保存后刷新带回的已删字段」
        // 误判为复活（ADD_FIELD 误发，后端 400 FIELD_STATUS 冲突）
        [id]: {
          detail: d,
          fields: d.fields.map((f: ModelField) => ({ ...f, ...(f.fieldStatus === 'DELETED' ? { _deleted: true } : {}) })),
          baseFields: d.fields,
        },
      }));
      return d;
    } catch (e) {
      setDetails((prev) => ({ ...prev, [id]: 'error' }));
      handleError(e);
      return null;
    }
  }, [api, appId]);

  /** 选中对象追踪（refreshDetail 旧响应判定用——避免闭包读到旧 selected）。 */
  const selectedRef = React.useRef<string | null>(null);
  React.useEffect(() => { selectedRef.current = selected; }, [selected]);

  /** 选中即拉取该模型详情（单请求——画布字段数与版本号渐进呈现）。 */
  const ensureDetail = React.useCallback(async (id: string) => {
    const cur = details[id];
    if (cur && cur !== 'loading' && cur !== 'error') return;
    await refreshDetail(id);
  }, [details, refreshDetail]);

  /** 限并发后台加载全部详情（画布全应用关系完整性——LOAD_CONCURRENCY 路连接占用）。
   *  加载完成后用真实关系边对「无坐标/退化坐标」节点做一次分层重排（首载时布局
   *  无关系输入会退化成单行超宽——fitView 被 minZoom 卡死）。 */
  const loadAllDetails = React.useCallback(async (list: ModelSummary[]) => {
    const pending = list.filter((m) => {
      const cur = details[m.id];
      return !cur || cur === 'error';
    }).map((m) => m.id);
    // 详情就地累积（不读 detailsRef——Promise.all resolve 时 React 可能未 flush 末次 setDetails，ref 滞后会让关系边提取拿到空集）
    const loaded: ModelDetail[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < pending.length) {
        const id = pending[cursor++];
        inflightRef.current++;
        try {
          const d = await refreshDetail(id, { background: true });
          if (d) loaded.push(d);
        } finally { inflightRef.current--; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, pending.length) }, worker));
    // 全部详情就绪 → 关系驱动的布局补齐（缺省/退化坐标节点重排——唯一持久化点）
    if (list.length && loaded.length) {
      const draft = loadLayoutDraft(tenantId, appId);
      const byId = new Map(loaded.map((d) => [d.id, d]));
      const edges = extractRelationEdges(list
        .filter((m) => byId.has(m.id))
        .map((m) => ({ id: m.id, fields: byId.get(m.id)!.fields })));
      const auto = layeredLayout(list, edges);
      let changed = false;
      for (const m of list) {
        const cur = draft.positions[m.id];
        // 无坐标或退化坐标（超出画布域）都重排；用户拖过的正常坐标不动
        if (!cur || Math.abs(cur.x) > CANVAS_LIMIT || Math.abs(cur.y) > CANVAS_LIMIT) {
          draft.positions[m.id] = auto[m.id] ?? { x: 40, y: 40 };
          changed = true;
        }
      }
      if (changed) {
        saveLayoutDraft(tenantId, appId, draft);
        setPositions({ ...draft.positions });
        setCanvasEpoch((e) => e + 1);   // 重挂载画布：全新 Handle 测量（修复重排后边渲染竞态）
      }
    }
  }, [details, refreshDetail, tenantId, appId]);

  React.useEffect(() => {
    if (models && models.length) void loadAllDetails(models);
    // 仅在模型列表首次装载/刷新时触发（details 变化会引起刷新循环——依赖里排除）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

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

  const selectedEntry = selected ? details[selected] : null;
  const selectedDetail = selectedEntry && selectedEntry !== 'loading' && selectedEntry !== 'error' ? selectedEntry : null;

  /** 生成当前草稿 vs 服务端版本的变更集（纯逻辑在 protocol 包 buildDraftChanges——可单测）。 */
  const buildChanges = React.useCallback((): ChangeOp[] => {
    if (!selectedDetail) return [];
    return buildDraftChanges(selectedDetail.baseFields, selectedDetail.fields);
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
      // 缓存失效：版本号/字段集同步新态；刷新失败显式提示（保存已成功，禁止用旧版本继续提交）
      const fresh = await refreshDetail(selectedDetail.detail.id);
      if (!fresh) message.warning('保存已成功，但详情刷新失败——请手动刷新页面获取新版本号');
      void loadModels();
    } catch (e) {
      // token 一次性：失败即关弹层作废，重新 precheck
      setConfirmOpen(false);
      if (e instanceof ApiError) {
        if (e.code === 'MODEL_VERSION_CONFLICT') {
          // 409 草稿保护（10FE §1.3 ⑥）：拉服务端最新做三方对比，本地草稿保留待用户显式裁决
          try {
            const server = await api.modelDetail(appId, selectedDetail.detail.id);
            const rows = buildConflictRows(selectedDetail.baseFields, selectedDetail.fields, server.fields);
            setConflictServer(server);
            setConflictRows(rows);
            setConflictOpen(true);
          } catch {
            message.error('版本冲突且服务端最新态拉取失败——本地草稿已保留，请稍后重试保存');
          }
          setPrecheck(null);
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

  // 回滚预检失败标记（弹层提供重试入口——不允许永久停在加载态）
  const [rollbackPreFailed, setRollbackPreFailed] = React.useState(false);

  const runRollback = React.useCallback(async (target: number): Promise<void> => {
    setSaving(true);
    setRollbackPreFailed(false);
    try {
      const pre = await api.rollbackPrecheck(appId, selectedDetail!.detail.id, target);
      // 回滚统一 TYPE_MODEL_NAME（01BE §4.3）；预检风险先呈现再提交（不静默越过高风险确认）
      setRollbackPre(pre);
    } catch (e) {
      handleError(e);
      setRollbackPreFailed(true);   // 弹层转失败态提供重试，不永久 loading
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

  // ---------- 渲染 ----------（关系边几何已全部移入 ErCanvas）

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
        <ErCanvas
          key={canvasEpoch}
          models={models}
          details={Object.fromEntries(Object.entries(details).filter(([, v]) => v && v !== 'loading' && v !== 'error')
            .map(([k, v]) => [k, { fields: (v as DraftModel).fields }]))}
          positions={positions}
          selected={selected}
          onSelect={(id) => { if (id) openDrawerSilently(id); }}
          onOpenEditor={openDrawer}
          onPositionsChange={(next) => {
            setPositions(next);
            saveLayoutDraft(tenantId, appId, { positions: next });
          }}
          onConnectModels={(sourceId, targetId) => {
            // 连线创建：打开 source 模型字段抽屉并预填 relation 目标（表单提交才真正落草稿）
            setSelected(sourceId);
            setDrawerOpen(true);
            void ensureDetail(sourceId).then(() => {
              setEditing({ placeholder: 'new' } as unknown as DraftField);
              setEditingIndex(-1);
              setEditingType('relation');   // 受控类型同步（连线预填场景）
              fieldForm.resetFields();
              fieldForm.setFieldsValue({ type: 'relation', relation: { targetModelId: targetId, cardinality: '1:n', cascade: 'FORBID' } });
            });
          }}
          onDeleteEdge={(sourceModelId, sourceFieldKey) => {
            // 删除边 = 删除对应 relation 字段（走字段变更协议——两段式保存确认）
            setSelected(sourceModelId);
            setDetails((prev) => {
              const cur = prev[sourceModelId];
              if (!cur || cur === 'loading' || cur === 'error') return prev;
              const next = cur.fields.map((f) => f.fieldKey === sourceFieldKey ? { ...f, _deleted: true } : f);
              return { ...prev, [sourceModelId]: { ...cur, fields: next } };
            });
            message.info(`关系字段 ${sourceFieldKey} 已标记删除——保存时按删除协议确认`);
          }}
        />
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

      {/* 字段编辑抽屉（error 态也开——失败可见可重试，不允许静默「无反应」） */}
      <Drawer title={`${selectedDetail?.detail.name ?? models?.find((m) => m.id === selected)?.name ?? ''} · 字段编辑`} width={480}
        open={drawerOpen && (!!selectedDetail || selectedEntry === 'error')}
        destroyOnClose
        onClose={() => { setDrawerOpen(false); setEditing(null); }}>
        {selectedEntry === 'error' && (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Typography.Text type="danger">详情加载失败——本地无数据缓存，请重试。</Typography.Text>
            <div style={{ marginTop: 16 }}>
              <Button type="primary" onClick={() => { if (selected) void ensureDetail(selected); }}>重试加载</Button>
              <Button style={{ marginLeft: 8 }} onClick={() => { setDrawerOpen(false); }}>关闭</Button>
            </div>
          </div>
        )}
        {selectedDetail && (
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
                    const curType = editingIndex >= 0 ? selectedDetail.fields[editingIndex].type : editingType;
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
                            cardinality: RELATION_CARDINALITIES.includes(v.relation.cardinality) ? v.relation.cardinality : '1:n',
                            cascade: RELATION_CASCADES.includes(v.relation.cascade) ? v.relation.cascade : 'FORBID',
                          };
                        }
                      }
                      if (typeof v.type === 'string' ? v.type === 'computed' : editingIndex >= 0 && selectedDetail.fields[editingIndex].type === 'computed') {
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
                      const next = [...selectedDetail.fields];
                      next[editingIndex] = { ...next[editingIndex], label: v.label, required: !!v.required, ...parseConfigs() };
                      setDetails((d) => {
                        const cur = d[selected!];
                        if (!cur || cur === 'loading' || cur === 'error') return d;
                        return { ...d, [selected!]: { ...cur, fields: next } };
                      });
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
                      setDetails((d) => {
                        const cur = d[selected!];
                        if (!cur || cur === 'loading' || cur === 'error') return d;
                        return { ...d, [selected!]: { ...cur, fields: [...cur.fields, newField] } };
                      });
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
              dataSource={selectedDetail.fields.map((f, i) => ({ f, i }))}
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
                        setDetails((d) => {
                          const cur = d[selected!];
                          if (!cur || cur === 'loading' || cur === 'error') return d;
                          const next = [...cur.fields];
                          next[i] = { ...next[i], _deleted: false };
                          return { ...d, [selected!]: { ...cur, fields: next } };
                        });
                      }}>撤销</Button>
                    ) : (
                      <Popconfirm key="del" title="删除该字段？（保存时强制勾选确认）" onConfirm={() => {
                        setDetails((d) => {
                          const cur = d[selected!];
                          if (!cur || cur === 'loading' || cur === 'error') return d;
                          const next = [...cur.fields];
                          next[i] = { ...next[i], _deleted: true };
                          return { ...d, [selected!]: { ...cur, fields: next } };
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

      {/* 409 三方对比弹层（10FE §1.3 ⑥ / 04FE §7 同款）：本地草稿保留，显式裁决 */}
      <Modal title={`版本冲突 · ${selectedDetail?.detail.name ?? ''}（他人已保存 v${conflictServer?.currentVersion ?? '?'}）`}
        open={conflictOpen} width={760} footer={null} onCancel={() => setConflictOpen(false)}>
        <Typography.Paragraph type="warning">
          你与服务端基于不同版本做了修改。下方为逐字段对比（我的草稿 / 服务端最新）；
          选择「放弃我的修改」将以服务端最新覆盖本地草稿；关闭弹层可继续保留草稿查看。
        </Typography.Paragraph>
        <List size="small" style={{ maxHeight: 320, overflow: 'auto' }}
          locale={{ emptyText: '无字段级差异' }}
          dataSource={conflictRows}
          renderItem={(row) => (
            <List.Item style={{ padding: '4px 0', background: row.bothChanged ? 'rgba(255,77,79,.06)' : undefined }}>
              <Space>
                <Tag color={row.bothChanged ? 'red' : 'blue'}>{row.bothChanged ? '双方修改' : '单方修改'}</Tag>
                <span>{row.fieldKey}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {'我的：'}{row.mine ? `${row.mine.op}` : '未改'}
                  {' / '}
                  {'服务端：'}{row.theirs ? `${row.theirs.op}` : '未改'}
                </Typography.Text>
              </Space>
            </List.Item>
          )} />
        <Space style={{ marginTop: 16 }}>
          <Button danger onClick={() => {
            // 显式放弃：以服务端态重建草稿（DELETED 字段带 _deleted——同 refreshDetail 形态，防复活误判）
            if (!conflictServer || !selected) return;
            setDetails((prev) => ({
              ...prev,
              [selected]: {
                detail: conflictServer,
                fields: adoptServerDraft(conflictServer.fields).map((f) => ({
                  ...f, ...(f.fieldStatus === 'DELETED' ? { _deleted: true } : {}),
                })) as DraftField[],
                baseFields: conflictServer.fields,
              },
            }));
            setConflictOpen(false);
            setConflictServer(null);
            setConflictRows([]);
            setPrecheck(null);
            message.info('已放弃本地修改，草稿与服务端 v' + conflictServer.currentVersion + ' 对齐');
          }}>{'放弃我的修改（采用服务端）'}</Button>
          <Button onClick={() => setConflictOpen(false)}>{'保留草稿，稍后处理'}</Button>
        </Space>
      </Modal>

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
        destroyOnClose
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
              ) : rollbackPreFailed ? (
                <div style={{ marginBottom: 12 }}>
                  <Typography.Text type="danger">回滚影响面获取失败——本地草稿未受影响，可重试。</Typography.Text>
                  <Button size="small" style={{ marginTop: 8 }} loading={saving}
                    onClick={() => { if (rollbackTarget != null) void runRollback(rollbackTarget); }}>
                    重试获取影响面
                  </Button>
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
