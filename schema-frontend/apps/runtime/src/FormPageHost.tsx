/**
 * 表单页装配（M11 最小宿主核心，2026-10-30）：
 * 发布 PageSchema + 字段元数据 → validate/migrate 协议校验 → FormStore（联动/校验）
 * → SchemaRenderer（节点级订阅）→ 受控物料输入 → 失焦校验 / 500ms 防抖唯一预检
 * → SUBMIT 防重 + 提交 → 错误回填。
 *
 * 装配边界（M11 定位）：本组件只做装载与装配——渲染归 M6 bindings、表单逻辑归 M7。
 *
 * 2026-10-30 收口：
 * - 协议接线：loadPage 后走 migrate + validatePageSchema（不再裸强转）；
 * - 错误订阅通道化：字段错误经 RenderScope FIELD_ERROR_CHANNEL 订阅分发——
 *   受控包装组件类型不再依赖错误闭包（此前 fieldErrors 变化重建全部 Enhanced
 *   组件 → 整表单重挂载丢焦点）；
 * - 防抖取消修复：DebouncedUniqueChecker.cancel 级联取消在途 Promise。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Spin, Typography } from 'antd';
import {
  FormStore, SubmitGuard, DebouncedUniqueChecker, executeSubmit, ServerError,
  type SubmitTransport,
} from '@schema/schema-form';
import { bindSchemaRenderer } from '@schema/schema-renderer';
import { migrate, validatePageSchema, type FieldSchema, type PageSchema } from '@schema/schema-protocol';
import { registerBasicMaterials, defaultWidgetFor } from '@schema/component-materials';
import { materialRegistry, RenderScope } from '@schema/schema-renderer';
import { RequestClient } from './request';
import { useScriptHooks } from './useScriptHooks';
import ListPageHost from './ListPageHost';

// 物料注册（一次性——宿主启动即装载全部基础物料）
let materialsReady = false;
function ensureMaterials(): void {
  if (materialsReady) return;
  registerBasicMaterials(materialRegistry);
  materialsReady = true;
}

// SchemaRenderer 工厂绑定（react 真实钩子注入——渲染包零运行时 react 红线）
const SchemaRenderer = bindSchemaRenderer({ createElement: React.createElement, useState, useEffect });

/** 页面加载状态机。 */
type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; page: PageSchema; fields: FieldSchema[] };

export interface FormPageHostProps {
  client: RequestClient;
  pageId: string | number;
  /** 记录 ID（编辑态——传入则装载详情回填）。 */
  recordId?: string | number;
  /** 提交成功行为回调（REFRESH/REDIRECT 由宿主路由层执行）。 */
  onSubmitted?: () => void;
  /** 缓存 ETag（304 命中输入——宿主缓存层注入）。 */
  etag?: string | null;
  /** 缓存 Schema（304 命中时的渲染真源——宿主缓存层注入）。 */
  cachedSchema?: unknown;
  /** 新 ETag + Schema 回写（宿主缓存层持久化；304 命中时 schema 为 null 不覆写缓存）。 */
  onEtag?: (etag: string | null, schema: unknown) => void;
}

export function FormPageHost({ client, pageId, recordId, onSubmitted, etag, cachedSchema, onEtag }: FormPageHostProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  // 页面 Schema + 字段元数据装载
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        ensureMaterials();
        const { schema, etag: newEtag } = await client.loadPage(pageId, etag);
        // 304 命中：schema 为 null——渲染真源取宿主缓存（同 ETag 同内容，协议保证）
        const effective = schema ?? cachedSchema;
        onEtag?.(newEtag, schema);
        // 协议接线（2026-10-30）：migrate 版本门禁 + validatePageSchema 结构校验——
        // 此前裸强转，坏 schema 直入渲染管线（不可预期的运行时崩溃）
        if (effective == null) throw new ServerError('LOAD_FAILED', '缓存缺失，请刷新页面');
        const migrated = migrate(effective as unknown as PageSchema);
        const page = validatePageSchema(migrated);
        if (!page?.modelId) throw new ServerError('PAGE_INVALID', '页面未绑定数据模型');
        const fieldsRaw = await client.loadFields(page.modelId);
        const fields = normalizeFields(fieldsRaw);
        validateLoadedFieldRefs(page, fields);
        if (cancelled) return;
        setState({ phase: 'ready', page, fields });
      } catch (e) {
        if (cancelled) return;
        setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [client, pageId, etag, cachedSchema]);

  if (state.phase === 'loading') return <Spin tip="页面加载中..." />;
  if (state.phase === 'error') {
    return <Alert type="error" showIcon message="页面加载失败" description={state.message} />;
  }
  if (state.page.type === 'LIST') {
    return <ListPageHost key={pageId} client={client} page={state.page} fields={state.fields} />;
  }
  if (state.page.type === 'DASHBOARD') {
    // 协议允许 DASHBOARD（chart-kit P2 未交付）——显式未支持提示，不静默落入表单宿主
    // 冒充已实现（2026-11-13 文档-实现对齐收口）。
    return (
      <Alert
        type="warning"
        showIcon
        message="仪表盘页面暂未支持"
        description="该页面类型需要图表物料运行时（后续版本交付）。当前版本仅支持表单/列表/详情页。"
      />
    );
  }
  if (state.page.type === 'DETAIL' && recordId == null) {
    return <Alert type="error" showIcon message="详情页面缺少记录 ID" />;
  }
  return (
    <SchemaFormPage
      key={`${pageId}-${recordId ?? 'new'}`}
      client={client}
      page={state.page}
      fields={state.fields}
      recordId={recordId}
      onSubmitted={onSubmitted}
    />
  );
}

/** 详情不存在时不显示旧数据：详情加载 404 视为终态错误（区别于网络抖动可重试）。 */
function DetailMissing(): React.ReactElement {
  return <Alert type="warning" showIcon message="记录不存在" description="该记录可能已被删除，请返回列表刷新查看" />;
}

/** 已装载页面渲染 + 提交闭环。 */
function SchemaFormPage({ client, page, fields, recordId, onSubmitted }: {
  client: RequestClient;
  page: PageSchema;
  fields: FieldSchema[];
  recordId?: string | number;
  onSubmitted?: () => void;
}): React.ReactElement {
  const readOnly = page.type === 'DETAIL';
  // 详情不存在终态（404）：不回填旧值、不渲染半空表单
  const [detailMissing, setDetailMissing] = useState(false);
  // FormStore：构造期破环 + 默认值装载 + 初始 effect 求值（M7 三轮收口后行为）
  const store = useMemo(() => new FormStore({
    fields,
    uniqueChecker: (fieldKey, value) => client.uniqueCheck(page.modelId!, fieldKey, value, recordId),
  }), [client, page.modelId, recordId, fields]);

  const debounced = useMemo(
    () => new DebouncedUniqueChecker((k, v) => client.uniqueCheck(page.modelId!, k, v, recordId)),
    [client, page.modelId, recordId],
  );
  useEffect(() => () => debounced.cancelAll(), [debounced]);

  const guard = useRef(new SubmitGuard());
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detailLoaded, setDetailLoaded] = useState(recordId == null);

  // M14 页面脚本（08FE §4.3 调度点）：onLoad 挂载完成 / beforeSubmit·afterSubmit 提交前后
  const scripts = useScriptHooks({ page, store, client, recordId });
  // 编辑态 onLoad 等详情回填完成后再触发（创建态 detailLoaded 初值即 true 立即触发）——
  // 不等待时钩子读到的表单值是空的（详情回填是异步 effect，早于它执行的 onLoad 拿不到记录）
  useEffect(() => {
    if (!detailLoaded) return;
    void scripts.onLoad();
  }, [scripts, detailLoaded]);
  // 字段变化通知（onFieldChange 绑定时订阅 store 写入——50ms 节流在 hook 内实现）
  useEffect(() => {
    if (!scripts.hasFieldChangeHook) return;
    return store.scope.subscribe([...store.fields.keys()], () => {
      // scope 只给变更信号不带键值——逐字段比对快照找出变更键（字段数有限，开销可忽略）
      for (const key of store.fields.keys()) {
        const cur = store.get(key);
        if (!Object.is(cur, fieldSnapshot.current.get(key))) {
          fieldSnapshot.current.set(key, cur);
          scripts.notifyFieldChange(key, cur);
        }
      }
    });
  }, [scripts, store]);
  const fieldSnapshot = useRef(new Map<string, unknown>());
  // 详情回填（编辑态）
  useEffect(() => {
    if (recordId == null || detailLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const row = (await client.detail(page.modelId!, recordId)) as Record<string, unknown>;
        if (cancelled) return;
        store.setValues(row);
        store.refreshEffects();
        store.publishErrors({});
      } catch (e) {
        if (cancelled) return;
        // 详情页 404：终态缺失而非网络错误——展示缺失占位，不回填不渲染旧数据
        if (e instanceof ServerError && e.code === 'NOT_FOUND') {
          setDetailMissing(true);
          return;
        }
        setGlobalError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDetailLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [recordId, detailLoaded, client, page.modelId, store]);

  // 受控字段包装：value/onChange/失焦校验/唯一预检注入每节点 props。
  // 错误展示走 RenderScope 通道订阅（Enhanced 组件内部 useState 订阅——
  // 类型不依赖 fieldErrors 闭包，错误更新不触发整树组件类型重建）。
  const resolveComponent = useCallback((componentName: string) => {
    if (componentName === '__UnknownWidget__') {
      return UnknownWidget as React.ComponentType<Record<string, unknown>>;
    }
    const meta = materialRegistry.get(componentName);
    return meta?.component as React.ComponentType<Record<string, unknown>> | undefined;
  }, []);

  // 字段包装工厂：组件类型按名缓存（EnhancedCache）——
  // ⚠️ 实测缺陷（M15 验收发现）：每次 resolve 都 new 组件函数时，NodeView 任何 bump
  // 都拿到新类型引用 → React 判定类型变化卸载重挂载全树 → 组件内错误状态/订阅
  // 重建，「提交校验失败但界面零反馈」的静默缺陷由此产生。缓存保证类型引用稳定。
  const enhancedCache = useMemo(
    () => new Map<string, React.ComponentType<Record<string, unknown>>>(),
    [resolveComponent, store, page, debounced, readOnly],
  );
  const enhanceResolve = useCallback((componentName: string) => {
    const cached = enhancedCache.get(componentName);
    if (cached) return cached;
    const base = resolveComponent(componentName);
    if (!base) return undefined;
    const Comp = base as React.ComponentType<Record<string, unknown>>;
    const Enhanced = (props: Record<string, unknown>): React.ReactElement => {
      const nodeId = props['data-node-id'] as string;
      const fieldRef = fieldRefOf(page, nodeId);
      const [err, setErr] = useState<string | null>(null);
      // 受控值订阅（M11 验收缺陷修复）：store.set 后包装组件必须重渲染回显——
      // 否则受控 value 恒为首次渲染快照，输入框打不上字（dispatchEvent 与真实键盘同症）。
      const [, bumpValue] = useState(0);
      // 字段错误订阅（通道分发——错误回填/清除即时可见，组件类型不变）
      useEffect(() => {
        if (!fieldRef) return;
        return store.subscribeFieldErrors(fieldRef, (message) => setErr(message));
      }, [fieldRef, store]);
      useEffect(() => {
        if (!fieldRef) return;
        return store.scope.subscribe([fieldRef], () => bumpValue((n) => n + 1));
      }, [fieldRef, store]);
      if (!fieldRef) return <Comp {...props} />;
      const field = store.fields.get(fieldRef);
      if (!field) return <Comp {...props} />;
      const effect = store.effectOf(fieldRef);
      if (!effect.visible) return <></>;
      const controlled: Record<string, unknown> = {
        ...props,
        value: store.get(fieldRef),
        disabled: readOnly || effect.disabled || props.disabled,
        options: effect.filteredOptions ?? props.options,
        status: err ? ('error' as const) : undefined,
      };
      return (
        <div>
          <Comp {...controlled}
            onChange={(v: unknown) => {
              store.set(fieldRef, v);
              // 唯一字段防抖预检（500ms）——错误经通道回填
              if (field.uniqueFlag) {
                debounced.check(fieldRef, v).then((ok) => {
                  store.publishErrors({ [fieldRef]: ok ? '' : '该值已被占用' });
                });
              }
            }}
            onBlur={() => {
              const message = store.validate(fieldRef);
              store.publishErrors({ [fieldRef]: message ?? '' });
            }} />
          {err ? <Typography.Text type="danger" style={{ fontSize: 12 }}>{err}</Typography.Text> : null}
        </div>
      );
    };
    const typed = Enhanced as unknown as React.ComponentType<Record<string, unknown>>;
    enhancedCache.set(componentName, typed);
    return typed;
  }, [resolveComponent, store, page, debounced, readOnly, enhancedCache]);

  // 提交（防重 + 三阶段协议 + 服务端错误回填 + 脚本钩子 beforeSubmit/afterSubmit）
  const handleSubmit = useCallback(async () => {
    if (!guard.current.enter()) return;
    setSubmitting(true);
    setGlobalError(null);
    try {
      // beforeSubmit 返回 false 阻断提交；超时按「不阻断」放行（08FE §4.3 韧性原则）
      const payload = { record: Object.fromEntries([...store.fields.keys()].map((k) => [k, store.get(k)])) };
      const pre = await scripts.beforeSubmit(payload);
      if (pre.ok && pre.value === false) {
        setGlobalError('提交被脚本阻断（beforeSubmit）');
        return;
      }
      const transport: SubmitTransport = {
        submit: (payload) => recordId != null
          ? client.update(page.modelId!, recordId, payload)
          : client.create(page.modelId!, payload),
      };
      const submitAction = page.actions.find((a) => a.type === 'SUBMIT') as
        | { type: 'SUBMIT'; successBehavior: 'REFRESH' | 'REDIRECT' | 'TOAST'; redirectTo?: string }
        | undefined;
      const result = await executeSubmit(store, {
        type: 'SUBMIT',
        successBehavior: submitAction?.successBehavior ?? 'TOAST',
        redirectTo: submitAction?.redirectTo,
      }, transport);
      if (!result.ok) {
        // 服务端字段错误经通道分发（组件订阅——不重建组件类型）
        const serverFieldErrors: Record<string, string> = {};
        for (const [k, v] of Object.entries(result.fieldErrors)) {
          if (v) serverFieldErrors[k] = v;
        }
        store.publishErrors(serverFieldErrors);
        // 前端校验错误补发（validateAll 首错）
        if (result.globalError) setGlobalError(result.globalError);
        else if (Object.keys(serverFieldErrors).length === 0) setGlobalError('提交失败');
        return;
      }
      store.publishErrors({});
      // afterSubmit 等待钩子完成再回调宿主（onSubmitted 常触发刷新/跳转——提前回调会卸载
      // 页面中断钩子执行；钩子失败/超时按「不阻断」韧性原则放行成功路径）
      void scripts.afterSubmit({ ...payload, result: { successBehavior: result.successBehavior } })
        .finally(() => onSubmitted?.());
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      guard.current.leave();
      setSubmitting(false);
    }
  }, [client, page, recordId, store, onSubmitted, scripts]);

  return (
    <Card title={page.name} style={{ maxWidth: 720, margin: '24px auto' }}>
      {detailMissing && <DetailMissing />}
      {globalError ? <Alert type="error" showIcon closable message={globalError} style={{ marginBottom: 16 }} /> : null}
      {!detailMissing && <SchemaRenderer
        page={page}
        scope={store.scope}
        fields={new Map(fields.map((f) => [f.key, f]))}
        resolveComponent={enhanceResolve}
        react={{ createElement: React.createElement, useState, useEffect }}
        // 宿主能力注入（05FE §5，M16 附件闭环）：FileUpload 物料经 customRequest 消费——
        // presign → local-put 直传 → complete 换真实 fileId（不再本地校验态回显）。
        hostProps={{
          uploader: (file: File, onProgress: (pct: number) => void) =>
            client.uploadAttachment(file, onProgress),
          downloader: (fileId: string) => client.attachmentDownloadUrl(fileId),
        }}
      />}
      {!readOnly && <Button type="primary" loading={submitting} onClick={handleSubmit} style={{ marginTop: 16 }}>
        提交
      </Button>}
      {/* 自定义动作按钮（onActionClick 钩子调度点——08FE §4.3；CALL_API/OPEN_PAGE 等
          独立语义动作 P2 接线，P1 只渲染钩子可响应的动作按钮触发通知）。
          只读详情页保留 CUSTOM_SCRIPT/CALL_API 按钮（布局自带按钮仍可触发——脚本影响业务
          不因宿主隐藏提交而失效；DELETE 写操作只读态禁用）。 */}
      {page.actions.filter((a) => a.type === 'CUSTOM_SCRIPT' || a.type === 'CALL_API').map((a) => (
        <Button key={a.type + ('apiName' in a ? a.apiName : '')} style={{ marginTop: 16, marginLeft: 8 }}
          disabled={detailMissing}
          onClick={() => { void scripts.onActionClick('apiName' in a ? a.apiName : a.type); }}>
          {a.type === 'CALL_API' && 'apiName' in a ? `调用 ${a.apiName}` : a.type}
        </Button>
      ))}
    </Card>
  );
}

/** 字段元数据规范化（后端响应 → FieldSchema[]——宽松键位兼容）。 */
function normalizeFields(raw: unknown): FieldSchema[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { fields?: unknown })?.fields)
      ? (raw as { fields: unknown[] }).fields
      : [];
  return arr.map((f, i) => {
    const o = f as Record<string, unknown>;
    return {
      key: String(o['key'] ?? o['fieldKey'] ?? `f${i}`),
      label: String(o['label'] ?? o['name'] ?? ''),
      type: (o['type'] ?? o['fieldType'] ?? 'text') as FieldSchema['type'],
      fieldStatus: (o['fieldStatus'] ?? (o['deletedAt'] ? 'DELETED' : 'ACTIVE')) as FieldSchema['fieldStatus'],
      required: !!o['required'],
      uniqueFlag: !!o['uniqueFlag'],
      defaultValue: o['defaultValue'] as FieldSchema['defaultValue'],
      enumOptions: o['enumOptions'] as FieldSchema['enumOptions'],
      sortOrder: typeof o['sortOrder'] === 'number' ? o['sortOrder'] : i,
    };
  });
}

/** 节点 fieldRef 提取（受控注入定位）。 */
export function validateLoadedFieldRefs(page: PageSchema, fields: FieldSchema[]): void {
  const known = new Set(fields.map(field => field.key));
  const visit = (nodes: PageSchema['layout']): void => {
    for (const node of nodes) {
      if (node.fieldRef !== undefined && !known.has(node.fieldRef)) {
        throw new ServerError('PAGE_INVALID', `节点 ${node.id} 引用了模型中不存在的字段 ${node.fieldRef}`);
      }
      if (node.children) visit(node.children);
    }
  };
  visit(page.layout);
}

function fieldRefOf(page: PageSchema, nodeId: string): string | undefined {
  const walk = (nodes: PageSchema['layout']): string | undefined => {
    for (const n of nodes) {
      if (n.id === nodeId) return n.fieldRef;
      if (n.children) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(page.layout);
}

/** 未注册物料占位（L-Node 级不白屏）。 */
function UnknownWidget(props: Record<string, unknown>): React.ReactElement {
  return <Alert type="warning" showIcon message={`未知物料: ${String(props['name'] ?? '')}`} />;
}

export default FormPageHost;
