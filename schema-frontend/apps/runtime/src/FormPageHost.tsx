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
}

export function FormPageHost({ client, pageId, recordId, onSubmitted }: FormPageHostProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  // 页面 Schema + 字段元数据装载
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        ensureMaterials();
        const { schema } = await client.loadPage(pageId);
        // 协议接线（2026-10-30）：migrate 版本门禁 + validatePageSchema 结构校验——
        // 此前裸强转，坏 schema 直入渲染管线（不可预期的运行时崩溃）
        const migrated = migrate(schema as unknown as PageSchema);
        const page = validatePageSchema(migrated);
        if (!page?.modelId) throw new ServerError('PAGE_INVALID', '页面未绑定数据模型');
        const fieldsRaw = await client.loadFields(page.modelId);
        const fields = normalizeFields(fieldsRaw);
        if (cancelled) return;
        setState({ phase: 'ready', page, fields });
      } catch (e) {
        if (cancelled) return;
        setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [client, pageId]);

  if (state.phase === 'loading') return <Spin tip="页面加载中..." />;
  if (state.phase === 'error') {
    return <Alert type="error" showIcon message="页面加载失败" description={state.message} />;
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

/** 已装载页面渲染 + 提交闭环。 */
function SchemaFormPage({ client, page, fields, recordId, onSubmitted }: {
  client: RequestClient;
  page: PageSchema;
  fields: FieldSchema[];
  recordId?: string | number;
  onSubmitted?: () => void;
}): React.ReactElement {
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

  // 字段包装工厂：组件类型仅在 store/page 变化时重建（错误状态组件内自管理）
  const enhanceResolve = useCallback((componentName: string) => {
    const base = resolveComponent(componentName);
    if (!base) return undefined;
    const Comp = base as React.ComponentType<Record<string, unknown>>;
    const Enhanced = (props: Record<string, unknown>): React.ReactElement => {
      const nodeId = props['data-node-id'] as string;
      const fieldRef = fieldRefOf(page, nodeId);
      const [err, setErr] = useState<string | null>(null);
      // 字段错误订阅（通道分发——错误回填/清除即时可见，组件类型不变）
      useEffect(() => {
        if (!fieldRef) return;
        return store.subscribeFieldErrors(fieldRef, (message) => setErr(message));
      }, [fieldRef, store]);
      if (!fieldRef) return <Comp {...props} />;
      const field = store.fields.get(fieldRef);
      if (!field) return <Comp {...props} />;
      const effect = store.effectOf(fieldRef);
      if (!effect.visible) return <></>;
      const controlled: Record<string, unknown> = {
        ...props,
        value: store.get(fieldRef),
        disabled: effect.disabled || props.disabled,
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
    return Enhanced as unknown as React.ComponentType<Record<string, unknown>>;
  }, [resolveComponent, store, page, debounced]);

  // 提交（防重 + 三阶段协议 + 服务端错误回填）
  const handleSubmit = useCallback(async () => {
    if (!guard.current.enter()) return;
    setSubmitting(true);
    setGlobalError(null);
    try {
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
      onSubmitted?.();
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : String(e));
    } finally {
      guard.current.leave();
      setSubmitting(false);
    }
  }, [client, page, recordId, store, onSubmitted]);

  return (
    <Card title={page.name} style={{ maxWidth: 720, margin: '24px auto' }}>
      {globalError ? <Alert type="error" showIcon closable message={globalError} style={{ marginBottom: 16 }} /> : null}
      <SchemaRenderer
        page={page}
        scope={store.scope}
        fields={new Map(fields.map((f) => [f.key, f]))}
        resolveComponent={enhanceResolve}
        react={{ createElement: React.createElement, useState, useEffect }}
      />
      <Button type="primary" loading={submitting} onClick={handleSubmit} style={{ marginTop: 16 }}>
        提交
      </Button>
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
