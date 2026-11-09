/**
 * M13 页面设计器工作区（PRD 02 §2.2 三栏 + 04FE §4 拖拽管线）：
 * - 页面列表：新建（空白/由模型生成）/删除/路径设置
 * - 设计画布：物料面板（HTML5 DnD）→ schema-renderer DesignMode 渲染 → 属性面板（propsSchema 生成）
 * - 编辑内核：DesignerStore（page-designer 包）——一切修改经命令系统
 * - 保存链路：手动 + 30s 节流自动 + 409 冲突弹层（草稿保留/放弃/覆盖）
 *
 * 预览：发布后走 preview-grants → runtime 预览路由（真实凭证链——不做画布内假预览）。
 */
import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Dropdown, Empty, Form, Input, List, message, Modal, Select, Space, Spin,
  Switch, Tag, Tooltip, Typography,
} from 'antd';
import type { MenuProps } from 'antd';
import { nanoid } from 'nanoid';
import {
  migrate, validatePageSchema, type FieldSchema, type LayoutNode, type PageSchema, type PropValue,
} from '@schema/schema-protocol';
import { bindSchemaRenderer, materialRegistry, RenderScope } from '@schema/schema-renderer';
import { registerBasicMaterials, defaultWidgetFor } from '@schema/component-materials';
import {
  acceptsChildren, checkPanelExpr, collectFieldRefs, DesignerStore, findNode, generateDefaultLayout,
  outlineOf, panelGroups, panelMaterial, validateDropTarget,
  type DesignerCommand, type PropFieldSchema,
} from '@schema/page-designer';
import { ApiClient, ApiError, type AppCard, type PageRow } from './api';

// 物料一次性注册（与 runtime 宿主同源）
let materialsReady = false;
function ensureMaterials(): void {
  if (materialsReady) return;
  registerBasicMaterials(materialRegistry);
  materialsReady = true;
}

const SchemaRenderer = bindSchemaRenderer({ createElement: React.createElement, useState, useEffect });
export default function PageDesignerTab({ api, app }: { api: ApiClient; app: AppCard }): React.ReactElement {
  const [pages, setPages] = React.useState<PageRow[] | null>(null);
  const [editing, setEditing] = React.useState<{ pageId: string; draftVersion: number } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await api.listPages(app.id);
      setPages(r.list);
    } catch (e) {
      showError(e);
      setPages([]);
    }
  }, [api, app.id]);

  React.useEffect(() => { void load(); }, [load]);

  if (editing) {
    return (
      <PageCanvas
        api={api}
        app={app}
        pageId={editing.pageId}
        initialDraftVersion={editing.draftVersion}
        onExit={() => { setEditing(null); void load(); }}
      />
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Text type="secondary">
          页面路径全局唯一；「由模型生成」按字段顺序生成默认表单布局（一次性快照——之后模型变更不自动改页面）。
        </Typography.Text>
        <Button type="primary" onClick={() => { ensureMaterials(); void openCreate(api, app.id, load); }}>新建页面</Button>
      </Space>
      <List
        loading={pages === null}
        dataSource={pages ?? []}
        locale={{ emptyText: '暂无页面——点击「新建页面」开始' }}
        renderItem={(p) => (
          <List.Item
            actions={[
              <Button key="design" type="link" onClick={async () => {
                ensureMaterials();
                try {
                  const d = await api.getPageDraft(p.id);
                  setEditing({ pageId: String(p.id), draftVersion: d.draftVersion });
                } catch (e) { showError(e); }
              }}>设计</Button>,
              <Button key="preview" type="link" onClick={() => void openPreview(api, app.id, p.id)}>预览</Button>,
              <Dropdown key="more" menu={moreMenu(api, p, load)} trigger={['click']}>
                <Button type="link">···</Button>
              </Dropdown>,
            ]}
          >
            <List.Item.Meta
              title={<Space>{p.name}<Tag>{p.pageKey}</Tag>{p.status === 'PUBLISHED' ? <Tag color="green">已发布</Tag> : <Tag>草稿</Tag>}</Space>}
            />
          </List.Item>
        )}
      />
    </Space>
  );
}

function moreMenu(api: ApiClient, p: PageRow, reload: () => Promise<void>): MenuProps {
  return {
    items: [
      { key: 'path', label: '路径设置', onClick: () => void editPath(api, p, reload) },
      { key: 'delete', label: '删除页面', danger: true, onClick: () => void removePage(api, p, reload) },
    ],
  };
}

async function openCreate(api: ApiClient, appId: number, reload: () => Promise<void>): Promise<void> {
  // 新建向导：名称/标识/路径 + 选模型（可选——绑定后设计器可配字段绑定；勾选「生成默认布局」
  // 则创建后按模型字段生成表单骨架，PRD 02 §2.1「由模型生成」）
  const models = await api.listModels(appId).catch(() => ({ list: [], total: 0 }));
  let chosen: { modelId?: string; name: string; pageKey: string; path: string; generate?: boolean } | null = null;
  const modal = Modal.info({
    title: '新建页面',
    width: 520,
    okText: '创建',
    closable: true,
    content: (
      <CreatePageForm
        models={models.list.map((m) => ({ value: m.id, label: m.name }))}
        onSubmit={(v) => { chosen = v; }}
      />
    ),
    onOk: async () => {
      if (!chosen) return Promise.reject();
      try {
        const created = await api.createPage(appId, {
          pageKey: chosen.pageKey, name: chosen.name, type: 'FORM',
          modelId: chosen.modelId, path: chosen.path,
        });
        // 由模型生成默认布局：创建成功后立即保存生成骨架（失败不阻断创建流程，提示手动生成）
        if (chosen.modelId && chosen.generate) {
          try {
            ensureMaterials();
            const draft = await api.getPageDraft(created.id);
            const schema = draft.schema as PageSchema;
            const detail = await api.modelDetail(appId, chosen.modelId);
            const page = validatePageSchema(migrate(schema));
            page.layout = generateDefaultLayout(normalizeFields(detail), {
              defaultWidgetFor, newId: () => nanoid(10),
            });
            await api.savePageDraft(created.id, page, draft.draftVersion);
          } catch (e) {
            message.warning('默认布局生成失败，可在设计器中手动搭建');
          }
        }
        message.success('页面已创建');
        modal.destroy();
        await reload();
      } catch (e) { showError(e); return Promise.reject(e); }
    },
  });
}

function CreatePageForm({ models, onSubmit }: {
  models: { value: string; label: string }[];
  onSubmit: (v: { type: 'FORM'; modelId?: string; generate: boolean; name: string; pageKey: string; path: string }) => void;
}): React.ReactElement {
  const [form] = Form.useForm();
  const [hasModel, setHasModel] = React.useState(false);
  return (
    <Form form={form} layout="vertical" onValuesChange={(): void => {
      // 收集当前值回调（受控提取——Modal onOk 消费）
      const v = form.getFieldsValue() as { name?: string; pageKey?: string; path?: string; modelId?: string; generate?: boolean };
      if (v.name && v.pageKey && v.path) {
        onSubmit({ type: 'FORM', modelId: v.modelId, generate: !!v.generate, name: v.name, pageKey: v.pageKey, path: v.path });
      }
    }}>
      <Form.Item name="name" label="页面名称" rules={[{ required: true }]}><Input placeholder="如：报销登记表" /></Form.Item>
      <Form.Item name="pageKey" label="页面标识" rules={[{ required: true }]}><Input placeholder="如：expense_form" /></Form.Item>
      <Form.Item name="path" label="访问路径" rules={[{ required: true }]}><Input placeholder="如：/expense/form" /></Form.Item>
      <Form.Item name="modelId" label="绑定模型（可选）">
        <Select allowClear options={models} placeholder="选择模型后可生成默认布局"
          onChange={(v) => { setHasModel(!!v); }} />
      </Form.Item>
      {hasModel ? (
        <Form.Item name="generate" label="由模型生成默认布局" valuePropName="checked" initialValue={true}>
          <Switch checkedChildren="生成" unCheckedChildren="空白" />
        </Form.Item>
      ) : null}
    </Form>
  );
}

async function editPath(api: ApiClient, p: PageRow, reload: () => Promise<void>): Promise<void> {
  let value = '';
  Modal.confirm({
    title: '路径设置',
    content: <Input defaultValue={`/p/${p.pageKey}`} onChange={(e) => { value = e.target.value; }} />,
    onOk: async () => {
      try {
        await api.updatePagePath(p.id, value || `/p/${p.pageKey}`);
        message.success('已更新');
        await reload();
      } catch (e) { showError(e); }
    },
  });
}

async function removePage(api: ApiClient, p: PageRow, reload: () => Promise<void>): Promise<void> {
  Modal.confirm({
    title: `删除页面「${p.name}」？`,
    content: '页面将从导航消失；逻辑删除不可自助恢复。',
    okButtonProps: { danger: true },
    onOk: async () => {
      try {
        await api.deletePage(p.id);
        message.success('已删除');
        await reload();
      } catch (e) { showError(e); }
    },
  });
}

async function openPreview(api: ApiClient, appId: number, pageId: string | number): Promise<void> {
  try {
    const r = await api.issuePreviewGrant(appId, pageId);
    const url = `${window.location.origin}/runtime/#/preview?grant=${encodeURIComponent(r.grantId)}`;
    window.open(url, '_blank');
  } catch (e) { showError(e); }
}

function showError(e: unknown): void {
  message.error(e instanceof Error ? e.message : String(e));
}

// ---------- 设计画布 ----------

interface CanvasProps {
  api: ApiClient;
  app: AppCard;
  pageId: string;
  initialDraftVersion: number;
  onExit: () => void;
}

function PageCanvas({ api, app, pageId, initialDraftVersion, onExit }: CanvasProps): React.ReactElement {
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

  // 装载草稿 + 模型字段
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        ensureMaterials();
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

// ---------- 属性面板（propsSchema 自动生成） ----------

function PropsPanel({ node, meta, fields, warned, onChange }: {
  node: LayoutNode;
  meta: { propsSchema: PropFieldSchema extends never ? never : import('@schema/page-designer').PropSchemaGroup[] } | undefined;
  fields: FieldSchema[];
  warned: boolean;
  onChange: (patch: Record<string, PropValue>) => void;
}): React.ReactElement {
  const activeFields = fields.filter((f) => f.fieldStatus === 'ACTIVE');
  const deletedFields = fields.filter((f) => f.fieldStatus === 'DELETED');
  const [exprFeedback, setExprFeedback] = React.useState<Record<string, string>>({});

  const renderField = (f: PropFieldSchema): React.ReactElement => {
    const value = node.props[f.key];
    switch (f.widget) {
      case 'fieldRef':
        return (
          <Form.Item key={f.key} label={f.label} validateStatus={warned ? 'warning' : undefined}>
            <Select
              allowClear
              value={typeof node.fieldRef === 'string' ? node.fieldRef : undefined}
              onChange={(v) => onChange({ fieldRef: v ?? '' })}
              options={[
                ...activeFields.map((fd) => ({ value: fd.key, label: `${fd.label} (${fd.key})` })),
                ...deletedFields.map((fd) => ({ value: fd.key, label: `${fd.label} (${fd.key}) ·已删除`, disabled: true })),
              ]}
              placeholder={fields.length === 0 ? '页面未绑定模型' : '选择字段'}
            />
          </Form.Item>
        );
      case 'switch':
        return (
          <Form.Item key={f.key} label={f.label} valuePropName="checked">
            <Switch checked={!!value} onChange={(v: boolean) => onChange({ [f.key]: v })} />
          </Form.Item>
        );
      case 'expr': {
        const err = exprFeedback[f.key];
        return (
          <Form.Item key={f.key} label={f.label} validateStatus={err ? 'error' : undefined} help={err}>
            <Input
              value={typeof value === 'string' ? value : ''}
              placeholder={f.placeholder}
              status={err ? 'error' : undefined}
              onChange={(e) => {
                const v = e.target.value;
                onChange({ [f.key]: v });
                if (!v.trim()) { setExprFeedback((s) => ({ ...s, [f.key]: '' })); return; }
                const r = checkPanelExpr(v);
                setExprFeedback((s) => ({ ...s, [f.key]: r.ok ? '' : (r.error?.message ?? '表达式错误') }));
              }}
            />
          </Form.Item>
        );
      }
      default:
        return (
          <Form.Item key={f.key} label={f.label}>
            <Input
              value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
              onChange={(e) => onChange({ [f.key]: e.target.value })}
            />
          </Form.Item>
        );
    }
  };

  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{node.componentName} · {node.id}</Typography.Text>
      {warned ? <Alert type="warning" showIcon message="该节点引用的字段已删除或不存在（标黄警示）" style={{ margin: '8px 0' }} /> : null}
      {meta?.propsSchema?.length ? (
        meta.propsSchema.map((g) => (
          <div key={g.title}>
            <Typography.Text strong style={{ fontSize: 13 }}>{g.title}</Typography.Text>
            {g.fields.map(renderField)}
          </div>
        ))
      ) : (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>该物料暂无可配置属性</Typography.Text>
      )}
    </div>
  );
}

// ---------- 409 三方差异摘要（本地 vs 服务器草稿） ----------

function ConflictDiff({ baseline, local, server }: { baseline: PageSchema; local: PageSchema; server: PageSchema }): React.ReactElement {
  const flatten = (page: PageSchema): Map<string, unknown> => {
    const values = new Map<string, unknown>();
    const walk = (nodes: LayoutNode[], parentId: string | null): void => {
      nodes.forEach((node, index) => {
        const { children, ...content } = node;
        values.set(node.id, { ...content, parentId, index });
        walk(children ?? [], node.id);
      });
    };
    const { layout, ...pageProps } = page;
    values.set('$page', pageProps);
    walk(layout, null);
    return values;
  };
  const baseValues = flatten(baseline), localValues = flatten(local), serverValues = flatten(server);
  const display = (value: unknown): string => value === undefined ? '不存在（新增/删除）' : JSON.stringify(value);
  const changes = [...new Set([...baseValues.keys(), ...localValues.keys(), ...serverValues.keys()])]
    .filter((id) => display(baseValues.get(id)) !== display(localValues.get(id))
      || display(baseValues.get(id)) !== display(serverValues.get(id)));
  const stats = React.useMemo(() => {
    const count = (nodes: LayoutNode[]): { nodes: number; bound: number } => {
      let n = 0, bound = 0;
      const walk = (arr: LayoutNode[]): void => {
        for (const x of arr) {
          n++;
          if (x.fieldRef) bound++;
          walk(x.children ?? []);
        }
      };
      walk(nodes);
      return { nodes: n, bound };
    };
    const l = count(local.layout ?? []);
    const s = count(server.layout ?? []);
    const exprKeys = ['visibleWhen', 'disabledWhen', 'requiredWhen'];
    const exprCount = (nodes: LayoutNode[]): number => {
      let c = 0;
      const walk = (inner: LayoutNode[]): void => {
        for (const x of inner) {
          for (const k of exprKeys) if (typeof x.props?.[k] === 'string' && (x.props[k] as string).trim()) c++;
          walk(x.children ?? []);
        }
      };
      walk(nodes);
      return c;
    };
    return {
      local: { ...l, expr: exprCount(local.layout ?? []) },
      server: { ...s, expr: exprCount(server.layout ?? []) },
    };
  }, [local, server]);
  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>三方内容差异（不自动合并）</Typography.Text>
      <List dataSource={changes} renderItem={(id) => (
        <List.Item key={id}>
          <Space direction="vertical">
            <Typography.Text strong>{id === '$page' ? '页面属性' : `节点 ${id}`}</Typography.Text>
            <Typography.Text>编辑基线：{display(baseValues.get(id))}</Typography.Text>
            <Typography.Text>本地草稿：{display(localValues.get(id))}</Typography.Text>
            <Typography.Text>服务器草稿：{display(serverValues.get(id))}</Typography.Text>
          </Space>
        </List.Item>
      )} />
      <table style={{ width: '100%', marginTop: 4, fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>维度</th>
            <th style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>本地（保留中）</th>
            <th style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>服务器 v{String(server.schemaVersion ?? '?')}</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style={{ padding: '2px 0' }}>节点数</td><td style={{ textAlign: 'right' }}>{stats.local.nodes}</td><td style={{ textAlign: 'right' }}>{stats.server.nodes}</td></tr>
          <tr><td style={{ padding: '2px 0' }}>字段绑定数</td><td style={{ textAlign: 'right' }}>{stats.local.bound}</td><td style={{ textAlign: 'right' }}>{stats.server.bound}</td></tr>
          <tr><td style={{ padding: '2px 0' }}>联动表达式数</td><td style={{ textAlign: 'right' }}>{stats.local.expr}</td><td style={{ textAlign: 'right' }}>{stats.server.expr}</td></tr>
        </tbody>
      </table>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        稍后处理不会更新版本；准备替换只更新基线，需手动保存；放弃会重新获取服务器草稿。
      </Typography.Text>
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

function UnknownWidget(props: Record<string, unknown>): React.ReactElement {
  return <Alert type="warning" showIcon message={`未知物料: ${String(props['name'] ?? '')}`} />;
}

/** 大纲行 → 容器节点 id（moveWithin 的 parentId 协议：根为 null，子容器为其节点 id）。 */
function findParentId(layout: LayoutNode[], parentArr: LayoutNode[]): string | null {
  for (const n of layout) {
    if (n.children === parentArr) return n.id;
    if (n.children) {
      const hit = findParentId(n.children, parentArr);
      if (hit) return hit;
    }
  }
  return null;
}

// 字段元数据规范化（与 runtime 宿主同构）
function normalizeFields(detail: unknown): FieldSchema[] {
  const raw = detail as { fields?: unknown[] } | null;
  const arr = raw?.fields ?? [];
  return (arr as Record<string, unknown>[]).map((o, i) => ({
    key: String(o['key'] ?? o['fieldKey'] ?? `f${i}`),
    label: String(o['label'] ?? o['name'] ?? ''),
    type: (o['type'] ?? o['fieldType'] ?? 'text') as FieldSchema['type'],
    fieldStatus: (o['fieldStatus'] ?? (o['deletedAt'] ? 'DELETED' : 'ACTIVE')) as FieldSchema['fieldStatus'],
    required: !!o['required'],
    uniqueFlag: !!o['uniqueFlag'],
    defaultValue: o['defaultValue'] as FieldSchema['defaultValue'],
    enumOptions: o['enumOptions'] as FieldSchema['enumOptions'],
    sortOrder: typeof o['sortOrder'] === 'number' ? o['sortOrder'] : i,
  }));
}

