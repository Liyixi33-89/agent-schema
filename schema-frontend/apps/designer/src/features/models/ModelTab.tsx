/**
 * M12 ER 建模器页签（10FE §1；消费 @schema/data-model-designer 协议层）：
 * - 画布：模型卡片节点（可拖拽，坐标 localStorage 草稿——视图态不入 Schema）
 * - 关系连线：SVG 直连（1:1 实线 / 1:n 燕尾箭头 / n:n 菱形标签）
 * - 字段抽屉：类型/字段名创建后禁用（后端铁律前端呈现）；ADD/MODIFY/DELETE/PROMOTE
 * - 两段式保存：precheck → 风险面板（severity 排序）→ 三档确认 → saveSchema；409/422 分态处理
 * - 版本时间线：diff 摘要 + rollback_from 标记；回滚走独立 precheck（confirmValue=模型名）
 *
 * 渐进重构第二批：字段编辑抽屉拆至 FieldEditorDrawer、弹层组拆至 ModelDialogs、
 * 共享类型拆至 modelTabShared——本文件收敛为状态与编排容器。
 */
import React from 'react';
import {
  Button, Empty, Form, Input, message, Modal, Space, Spin, Tag, Typography,
} from 'antd';
import { ApiError, type ApiClient, type ModelDetail, type ModelSummary, type PrecheckResp, type VersionRow } from '../../shared/api';
import ErCanvas from './ErCanvas';
import {
  effectiveConfirmMode, layeredLayout,
  loadLayoutDraft, saveLayoutDraft, extractRelationEdges,
  buildDraftChanges, buildConflictRows,
  type ChangeOp, type ConflictRow,
} from '@schema/data-model-designer';
import {
  DELETE_ACK_IDX, handleError,
  type DraftField, type DraftModel, type DetailState,
} from './modelTabShared';
import FieldEditorDrawer from './FieldEditorDrawer';
import { ConflictModal, SaveConfirmModal, VersionsDrawer, serverDraftOf } from './ModelDialogs';

export default function ModelTab({ api, appId }: { api: ApiClient; appId: number }): React.ReactElement {
  const [models, setModels] = React.useState<ModelSummary[] | null>(null);
  const [details, setDetails] = React.useState<Record<string, DetailState>>({});
  const [selected, setSelected] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createForm] = Form.useForm();
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
  // 回滚预检失败标记（弹层提供重试入口——不允许永久停在加载态）
  const [rollbackPreFailed, setRollbackPreFailed] = React.useState(false);
  // 连线预填（画布连线 → 字段抽屉 relation 预填；null=常规打开）
  const [presetRelation, setPresetRelation] = React.useState<{ targetModelId: string } | null>(null);

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

  /** 选中对象追踪（refreshDetail 旧响应判定用——避免闭包读到旧 selected）。 */
  const selectedRef = React.useRef<string | null>(null);
  React.useEffect(() => { selectedRef.current = selected; }, [selected]);

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
          fields: d.fields.map((f) => ({ ...f, ...(f.fieldStatus === 'DELETED' ? { _deleted: true } : {}) })),
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
    setPresetRelation(null);
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

  /** 字段集变更（FieldEditorDrawer 回写——本地草稿态）。 */
  const onFieldsChange = (fields: DraftField[]): void => {
    setDetails((d) => {
      const cur = d[selected!];
      if (!cur || cur === 'loading' || cur === 'error') return d;
      return { ...d, [selected!]: { ...cur, fields } };
    });
  };

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
            setPresetRelation({ targetModelId: targetId });
            setDrawerOpen(true);
            void ensureDetail(sourceId);
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
      <FieldEditorDrawer
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setPresetRelation(null); }}
        draft={selectedDetail}
        loadError={selectedEntry === 'error'}
        onRetry={() => { if (selected) void ensureDetail(selected); }}
        models={models}
        onFieldsChange={onFieldsChange}
        presetRelation={presetRelation}
      />

      {/* 409 三方对比弹层（10FE §1.3 ⑥ / 04FE §7 同款）：本地草稿保留，显式裁决 */}
      <ConflictModal
        open={conflictOpen}
        onClose={() => setConflictOpen(false)}
        server={conflictServer}
        rows={conflictRows}
        modelName={selectedDetail?.detail.name ?? ''}
        onDiscard={(server) => {
          if (!selected) return;
          setDetails((prev) => ({ ...prev, [selected]: serverDraftOf(server) }));
          setConflictOpen(false);
          setConflictServer(null);
          setConflictRows([]);
          setPrecheck(null);
          message.info('已放弃本地修改，草稿与服务端 v' + server.currentVersion + ' 对齐');
        }}
      />

      {/* 两段式确认弹层：左变更清单 + 右影响面（severity 排序） */}
      <SaveConfirmModal
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={() => { void submitConfirm(); }}
        precheck={precheck}
        changes={pendingChanges}
        hasDelete={hasDelete}
        effMode={effMode}
        checkedRisks={checkedRisks}
        onCheckRisk={(idx, checked) => {
          setCheckedRisks((s) => {
            const next = new Set(s);
            if (checked) next.add(idx); else next.delete(idx);
            return next;
          });
        }}
        modelNameInput={modelNameInput}
        onModelNameInput={setModelNameInput}
        canSubmit={canSubmitConfirm()}
        saving={saving}
        modelName={selectedDetail?.detail.name ?? ''}
      />

      {/* 版本时间线与回滚 */}
      <VersionsDrawer
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        versions={versions}
        currentVersion={selectedDetail?.detail.currentVersion ?? null}
        modelName={selectedDetail?.detail.name ?? ''}
        rollbackTarget={rollbackTarget}
        rollbackPre={rollbackPre}
        rollbackPreFailed={rollbackPreFailed}
        rollbackConfirm={rollbackConfirm}
        saving={saving}
        onRollbackTarget={(v) => { setRollbackTarget(v); setRollbackConfirm(''); setRollbackPre(null); void runRollback(v); }}
        onRollbackConfirm={setRollbackConfirm}
        onRollbackSubmit={() => { void submitRollback(); }}
        onRollbackRetry={() => { if (rollbackTarget != null) void runRollback(rollbackTarget); }}
        onRollbackCancel={() => { setRollbackTarget(null); setRollbackPre(null); }}
      />
    </>
  );
}
