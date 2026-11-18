/**
 * 页面设计画布（M13 三栏布局——自 PageDesignerTab.tsx 原样抽出，行为不变）：
 * - 顶部工具栏：撤销/重做/移动预览/保存（30s 节流自动）/预览/脚本
 * - 三栏：物料面板+大纲 / DesignMode 渲染画布 / 属性面板
 * - 编辑内核：DesignerStore——一切修改经命令系统
 * - 保存链路：手动 + 30s 节流自动 + 409 冲突弹层（草稿保留/放弃/覆盖）
 */
import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Drawer, Empty, Form, Input, List, message, Modal, Select, Space, Spin, Tag, Tooltip, Typography,
} from 'antd';
import { nanoid } from 'nanoid';
import {
  migrate, validatePageSchema, type FieldSchema, type LayoutNode, type PageSchema, type PropValue,
} from '@schema/schema-protocol';
import { bindSchemaRenderer, materialRegistry, RenderScope } from '@schema/schema-renderer';
import { defaultWidgetFor } from '@schema/component-materials';
import {
  acceptsChildren, checkPanelExpr, DesignerStore, findNode, outlineOf, panelGroups, panelMaterial, validateDropTarget,
  type DesignerCommand,
} from '@schema/page-designer';
import { ApiClient, ApiError, type AppCard } from './api';
import ScriptPanel from './ScriptPanel';
import { ensureMaterials, findParentId, normalizeFields, showError } from './designerSupport';
import { PropsPanel, ConflictDiff } from './DesignerPanels';
import { openPreview } from './PageListPanel';
import { UnknownWidget } from '@schema/shared-ui';

const SchemaRenderer = bindSchemaRenderer({ createElement: React.createElement, useState, useEffect });

export interface CanvasProps {
  api: ApiClient;
  app: AppCard;
  pageId: string;
  initialDraftVersion: number;
  onExit: () => void;
}

export default function PageCanvas({ api, app, pageId, initialDraftVersion, onExit }: CanvasProps): React.ReactElement {
  const [state, setState] = React.useState<{ phase: 'loading' } | { phase: 'error'; message: string } | {
    phase: 'ready';
  }>({ phase: 'loading' });
  const storeRef = React.useRef<DesignerStore | null>(null);
  const baselineRef = React.useRef<PageSchema | null>(null);
  const [version, setVersion] = React.useState(0); // doc 变更计数（订阅触发重渲染）
  const [selected, setSelected] = React.useState<string | null>(null);
  const [fields, setFields] = React.useState<FieldSchema[]>([]);
  const [draftVersion, setDraftVersion] = React.useState(initialDraftVersion);
  const [conflict, setConflict] = React.useState<{ serverVersion: number; serverDoc: PageSchema } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const conflictPendingRef = React.useRef(false);
  const [mobileView, setMobileView] = React.useState(false);
  const [scriptOpen, setScriptOpen] = React.useState(false);
  // 图表数据源配置（spec 017）：应用模型清单 + 当前选中数据源模型的字段（按需装载缓存）
  const [models, setModels] = React.useState<{ value: string; label: string }[]>([]);
  const [dsModelFields, setDsModelFields] = React.useState<FieldSchema[]>([]);
  const dsFieldsCache = React.useRef(new Map<string, FieldSchema[]>());
  const loadDsModelFields = React.useCallback((modelId: string): void => {
    const cached = dsFieldsCache.current.get(modelId);
    if (cached) { setDsModelFields(cached); return; }
    void api.modelDetail(app.id, modelId).then((detail) => {
      const normalized = normalizeFields(detail);
      dsFieldsCache.current.set(modelId, normalized);
      setDsModelFields(normalized);
    }).catch(() => setDsModelFields([]));
  }, [api, app.id]);

  // 装载草稿 + 模型字段 + 应用模型清单（图表数据源下拉）
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        ensureMaterials();
        api.listModels(app.id)
          .then((r) => { if (!cancelled) setModels(r.list.map((m) => ({ value: m.id, label: m.name }))); })
          .catch(() => { /* 模型清单装载失败不阻断画布——图表数据源面板降级为手输 */ });
        const d = await api.getPageDraft(pageId);
        const migrated = migrate(d.schema as PageSchema);
        const page = validatePageSchema(migrated);
        if (!cancelled) {
          baselineRef.current = structuredClone(page);
          storeRef.current = new DesignerStore(page);
          storeRef.current.subscribe(() => setVersion((n) => n + 1));
          setDraftVersion(d.draftVersion);
          setState({ phase: 'ready' });
          if (page.modelId) {
            const detail = await api.modelDetail(app.id, page.modelId).catch(() => null);
            if (!cancelled && detail) setFields(normalizeFields(detail));
          }
        }
      } catch (e) {
        if (!cancelled) setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [api, pageId, app.id]);

  const store = storeRef.current;
  const doc = store?.document;
  const dirty = store?.dirty ?? false;

  // 差异检测（04FE §6）：引用 DELETED/不存在字段 → 警示节点集
  const warnedNodes = React.useMemo(() => {
    if (!doc) return new Set<string>();
    const activeKeys = new Set(fields.filter((f) => f.fieldStatus === 'ACTIVE').map((f) => f.key));
    const deletedKeys = new Set(fields.filter((f) => f.fieldStatus === 'DELETED').map((f) => f.key));
    const warned = new Set<string>();
    const walk = (nodes: LayoutNode[]): void => {
      for (const n of nodes) {
        if (n.fieldRef && (deletedKeys.has(n.fieldRef) || (fields.length > 0 && !activeKeys.has(n.fieldRef) && !deletedKeys.has(n.fieldRef)))) {
          warned.add(n.id);
        }
        walk(n.children ?? []);
      }
    };
    walk(doc.layout);
    return warned;
    // version 变更 = doc 引用变更（订阅计数）——须触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, fields, version]);

  // 表达式阻断校验（PRD 02 §2.2.3）：错误存在时禁止保存
  const exprErrors = React.useMemo(() => {
    if (!doc) return [];
    const errors: { nodeId: string; message: string }[] = [];
    const walk = (nodes: LayoutNode[]): void => {
      for (const n of nodes) {
        for (const key of ['visibleWhen', 'disabledWhen', 'requiredWhen']) {
          const v = n.props[key];
          if (typeof v === 'string' && v.trim()) {
            const r = checkPanelExpr(v);
            if (!r.ok) errors.push({ nodeId: n.id, message: `${key}: ${r.error?.message}` });
          }
        }
        walk(n.children ?? []);
      }
    };
    walk(doc.layout);
    return errors;
  }, [doc, version]);

  // 30s 自动保存（04FE §3）——表达式错误阻断一切保存（手动/自动/预览前），
  // 且仅在前次保存完成后触发新一轮（saving 期间跳过，防回执把新编辑误标已保存）。
  React.useEffect(() => {
    if (state.phase !== 'ready' || !store) return;
    const timer = window.setInterval(() => {
      if (store.dirty && !saving && exprErrors.length === 0) void doSave(false);
    }, 30_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, store, draftVersion, saving, exprErrors.length]);

  const doSave = React.useCallback(async (manual = true): Promise<boolean> => {
    if (!store || savingRef.current || conflict !== null || (!manual && conflictPendingRef.current)) return false;
    // 表达式阻断（PRD 02 §2.2.3）：错误存在时禁止一切保存（含自动与预览前触发）
    if (exprErrors.length > 0) {
      if (manual) message.error(`表达式错误 ${exprErrors.length} 处，已阻断保存`);
      return false;
    }
    // 深快照固定请求内容；回执只推进该快照的保存基线，期间新编辑保持 dirty
    const savedDoc = structuredClone(store.document);
    savingRef.current = true;
    setSaving(true);
    try {
      const r = await api.savePageDraft(pageId, savedDoc, draftVersion);
      setDraftVersion(r.draftVersion);
      store.markSaved(savedDoc);
      baselineRef.current = structuredClone(savedDoc);
      conflictPendingRef.current = false;
      // 否则：保存期间有新编辑，保持 dirty 待下一轮保存
      if (manual) message.success('已保存');
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DRAFT_VERSION_CONFLICT') {
        const server = await api.getPageDraft(pageId);
        conflictPendingRef.current = true;
        setConflict({ serverVersion: server.draftVersion, serverDoc: server.schema as PageSchema });
      } else {
        showError(e);
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pageId, store, draftVersion, saving, exprErrors.length, conflict]);

  const execute = React.useCallback((cmd: DesignerCommand, label?: string) => {
    store?.execute(cmd, label);
  }, [store]);

  if (state.phase === 'loading') return <div style={{ textAlign: 'center', padding: 64 }}><Spin /></div>;
  if (state.phase === 'error') {
    return <Alert type="error" showIcon message="草稿加载失败" description={state.message}
      action={<Button onClick={onExit}>返回</Button>} />;
  }
  if (!store || !doc) return <Empty />;

  const selectedNode = selected ? findNode(doc.layout, selected)?.node : undefined;
  const selectedMeta = selectedNode ? panelMaterial(selectedNode.componentName) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)' }}>
      {/* 顶部工具栏 */}
      <Space style={{ marginBottom: 8 }}>
        <Button onClick={onExit}>← 返回列表</Button>
        <Typography.Text strong>{doc.name}</Typography.Text>
        <Tooltip title={store.undoLabel() ?? ''}>
          <Button disabled={!store.canUndo} onClick={() => store.undo()}>撤销</Button>
        </Tooltip>
        <Tooltip title={store.redoLabel() ?? ''}>
          <Button disabled={!store.canRedo} onClick={() => store.redo()}>重做</Button>
        </Tooltip>
        <Button onClick={() => setMobileView((m) => !m)}>{mobileView ? 'PC 视图' : '移动预览 375px'}</Button>
        <Button loading={saving} disabled={!dirty}
          onClick={() => void doSave(true)}>保存{dirty ? ' ·未保存' : ''}</Button>
        <Button type="primary" onClick={async () => {
          const ok = exprErrors.length > 0 ? false : (dirty ? await doSave(true) : true);
          if (ok) { void openPreview(api, app.id, pageId); }
        }}>预览</Button>
        <Button onClick={() => setScriptOpen(true)}>脚本</Button>
        {scriptOpen ? (
          <Drawer title="L2 脚本（测试台）" open width={720} destroyOnClose
            onClose={() => setScriptOpen(false)}>
            <ScriptPanel api={api} pageId={pageId}
              initialScripts={doc?.scripts?.map((s) => ({ scriptId: s.scriptId, hook: s.hook, contentHash: s.contentHash, sourceHash: s.sourceHash, source: s.source }))}
              onScriptsBound={(scripts) => {
                // 经命令系统回写（可撤销唯一入口）；后续保存把 scripts 随 PageSchema 落库
                execute({ type: 'updateScripts', scripts }, `绑定脚本 ${scripts.length} 个钩子`);
              }} />
          </Drawer>
        ) : null}
        {exprErrors.length > 0 ? (
          <Tooltip title={exprErrors.map((e) => e.message).join('；')}>
            <Tag color="red">表达式错误 {exprErrors.length} 处（阻断保存）</Tag>
          </Tooltip>
        ) : null}
        {warnedNodes.size > 0 ? <Tag color="orange">{warnedNodes.size} 处字段引用异常</Tag> : null}
      </Space>

      {/* 三栏 */}
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        {/* 左：物料面板 + 大纲 */}
        <Card size="small" title="物料" style={{ width: 220, overflow: 'auto' }}>
          {panelGroups().map((g) => (
            <div key={g.title} style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{g.title}</Typography.Text>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 4 }}>
                {g.materials.map((m) => (
                  <div
                    key={m.componentName}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('application/x-schema-material', m.componentName); }}
                    style={{ padding: '6px 8px', border: '1px solid #d9d9d9', borderRadius: 6, cursor: 'grab', fontSize: 12 }}
                  >
                    {m.componentName}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>大纲</Typography.Text>
          <div style={{ marginTop: 4 }}>
            {outlineOf(doc.layout).map((row) => {
              const hit = findNode(doc.layout, row.id);
              const siblings = hit ? hit.parent : null;
              return (
                <div key={row.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '2px 0 2px ' + row.depth * 14 + 'px', cursor: 'pointer', fontSize: 12,
                    background: selected === row.id ? '#e6f4ff' : undefined,
                    color: warnedNodes.has(row.id) ? '#d46b08' : undefined,
                  }}
                  onClick={() => setSelected(row.id)}
                >
                  <span style={{ flex: 1 }} title={row.label}>{row.label}</span>
                  <a style={{ fontSize: 11 }} onClick={(e) => {
                    e.stopPropagation();
                    if (!hit || !siblings) return;
                    if (hit.index === 0) return;
                    execute({ type: 'moveWithin', parentId: hit.parent === doc.layout ? null : (findParentId(doc.layout, hit.parent) ?? null), fromIndex: hit.index, toIndex: hit.index - 1 }, '上移');
                  }}>↑</a>
                  <a style={{ fontSize: 11 }} onClick={(e) => {
                    e.stopPropagation();
                    if (!hit || !siblings) return;
                    if (hit.index >= siblings.length - 1) return;
                    execute({ type: 'moveWithin', parentId: hit.parent === doc.layout ? null : (findParentId(doc.layout, hit.parent) ?? null), fromIndex: hit.index, toIndex: hit.index + 1 }, '下移');
                  }}>↓</a>
                  <a style={{ fontSize: 11, color: '#cf1322' }} onClick={(e) => {
                    e.stopPropagation();
                    execute({ type: 'delete', nodeId: row.id }, `删除 ${row.label}`);
                    if (selected === row.id) setSelected(null);
                  }}>×</a>
                </div>
              );
            })}
          </div>
        </Card>

        {/* 中：画布（DesignMode） */}
        <Card size="small" style={{ flex: 1, overflow: 'auto' }} styles={{ body: { padding: 12 } }}>
          <CanvasSelectionSync selected={selected} warned={warnedNodes} onSelect={setSelected} />
          <div
            style={mobileView ? { maxWidth: 375, margin: '0 auto' } : undefined}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              const name = e.dataTransfer.getData('application/x-schema-material');
              if (!name) return;
              const meta = panelMaterial(name);
              if (!meta) return;
              // 容器嵌套（04FE §4）：拖到容器节点上 → 插入其 children；画布空白 → 根末尾。
              // 落点校验统一走 validateDropTarget（容器白名单/深度≤8/自嵌套）。
              const dropTargetId = dropTargetRef.current;
              dropTargetRef.current = null;
              let parentId: string | null = null;
              if (dropTargetId) {
                const target = findNode(doc.layout, dropTargetId);
                if (target && acceptsChildren(target.node.componentName)) parentId = dropTargetId;
              }
              const check = validateDropTarget(doc, parentId, [], { acceptsChildren });
              if (!check.ok) { message.warning(check.reason ?? '落点不合法'); return; }
              const arr = parentId === null ? doc.layout : (findNode(doc.layout, parentId)?.node.children ?? []);
              const node: LayoutNode = {
                id: nanoid(10), componentName: name,
                props: { ...meta.defaultProps } as Record<string, PropValue>,
                ...(meta.acceptChildren ? { children: [] } : {}),
              };
              execute({ type: 'insert', parentId, index: arr?.length ?? 0, node }, `插入 ${name}`);
              setSelected(node.id);
            }}
          >
            {doc.layout.length === 0 ? (
              <div onDragOver={(e) => e.preventDefault()}
                style={{ border: '2px dashed #d9d9d9', borderRadius: 8, padding: 48, textAlign: 'center', color: '#999' }}>
                拖拽左侧物料到此处开始搭建页面
              </div>
            ) : (
              <SchemaRenderer
                page={doc}
                scope={new RenderScope()}
                fields={new Map(fields.map((f) => [f.key, f]))}
                resolveComponent={designerResolve}
                react={{ createElement: React.createElement, useState, useEffect }}
              />
            )}          </div>
        </Card>

        {/* 右：属性面板 */}
        <Card size="small" title="属性" style={{ width: 300, overflow: 'auto' }}>
          {!selectedNode ? (
            <Typography.Text type="secondary">选中画布节点后配置属性</Typography.Text>
          ) : (
            <PropsPanel
              node={selectedNode}
              meta={selectedMeta}
              fields={fields}
              warned={warnedNodes.has(selectedNode.id)}
              models={models}
              dsModelFields={dsModelFields}
              onLoadModelFields={loadDsModelFields}
              onChange={(patch) => execute({ type: 'updateProps', nodeId: selectedNode.id, patch })}
            />
          )}
        </Card>
      </div>

      {/* 409 冲突弹层（草稿保留 + 三方差异 + 显式二选一） */}
      <Modal
        open={conflict !== null}
        title="草稿版本冲突（409）"
        closable={false}
        width={560}
        footer={[
          <Button key="keep" onClick={() => setConflict(null)}>保留我的修改，稍后处理</Button>,
          <Button key="replace" danger onClick={() => {
            if (!conflict) return;
            setDraftVersion(conflict.serverVersion);
            store.markSaved(conflict.serverDoc);
            baselineRef.current = structuredClone(conflict.serverDoc);
            setConflict(null);
            message.warning('已保留本地内容并更新基线；请手动保存以替换服务器草稿');
          }}>保留本地并准备替换服务器草稿</Button>,
          <Button key="discard" danger onClick={async () => {
            const fresh = await api.getPageDraft(pageId);
            const page = validatePageSchema(migrate(fresh.schema as PageSchema));
            store.load(page);
            baselineRef.current = structuredClone(page);
            setDraftVersion(fresh.draftVersion);
            conflictPendingRef.current = false;
            setSelected(null);
            setConflict(null);
            message.info('已放弃本地修改，对齐服务器版本');
          }}>放弃我的修改</Button>,
        ]}
      >
        <Alert type="warning" showIcon message={`服务器草稿已更新到 v${conflict?.serverVersion ?? '?'}，你的本地草稿已保留。`}
          description="稍后处理保留草稿并暂停自动保存；准备替换会更新基线，需再次手动保存；放弃则重新获取服务器内容。" />
        {conflict?.serverDoc && doc ? <ConflictDiff baseline={baselineRef.current ?? doc} local={doc} server={conflict.serverDoc} /> : null}
      </Modal>
    </div>
  );
}

// ---------- 设计态渲染（wrapNode：选中/标黄包装） ----------

/** 画布选中上下文（模块级——designerResolve 包装组件读取；渲染期间同步）。 */
const canvasSelection: { selected: string | null; warned: Set<string>; onSelect: (id: string) => void } = {
  selected: null, warned: new Set(), onSelect: () => {},
};

/** 拖拽落点（容器节点 hover 目标——HTML5 DnD dragover 不冒泡受控值，用模块级暂存）。 */
const dropTargetRef: { current: string | null } = { current: null };

/** 每次画布渲染前同步选中/警示状态（React 渲染期同步写模块上下文——包装组件即时读取）。 */
function CanvasSelectionSync({ selected, warned, onSelect }: {
  selected: string | null; warned: Set<string>; onSelect: (id: string) => void;
}): null {
  canvasSelection.selected = selected;
  canvasSelection.warned = warned;
  canvasSelection.onSelect = onSelect;
  return null;
}

function designerResolve(componentName: string): React.ComponentType<Record<string, unknown>> | undefined {
  // 包装组件工厂：注入选中边框与标黄（画布状态经模块级 canvasContext 传递——React 闭包重建成本高）
  const meta = materialRegistry.get(componentName);
  if (!meta?.component) {
    if (componentName === '__UnknownWidget__') {
      return UnknownWidget as React.ComponentType<Record<string, unknown>>;
    }
    return undefined;
  }
  const Wrapped = (props: Record<string, unknown>): React.ReactElement => {
    const nodeId = props['data-node-id'] as string;
    const isSelected = canvasSelection.selected === nodeId;
    const isWarned = canvasSelection.warned.has(nodeId);
    const isContainer = acceptsChildren(componentName);
    return (
      <div
        data-node-id={nodeId}
        onClick={(e) => { e.stopPropagation(); canvasSelection.onSelect(nodeId); }}
        onDragOver={(e) => {
          // 容器节点才可作为嵌套落点（04FE §4）；叶子节点 hover 不改落点（落入最近容器）
          if (isContainer) { e.preventDefault(); e.stopPropagation(); dropTargetRef.current = nodeId; }
        }}
        style={{
          outline: isSelected ? '2px solid #1677ff' : isWarned ? '2px dashed #faad14' : '1px dashed transparent',
          outlineOffset: 2, cursor: 'pointer', position: 'relative',
          ...(isContainer ? { minHeight: 28, background: 'rgba(22, 119, 255, 0.03)' } : {}),
        }}
      >
        {React.createElement(meta.component as React.ComponentType<Record<string, unknown>>, props)}
      </div>
    );
  };
  return Wrapped;
}
