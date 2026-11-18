/**
 * 已装载表单页渲染 + 提交闭环（渐进重构第四批——自 FormPageHost.tsx 原样抽出，行为不变）：
 * FormStore 构造期破环 / 受控字段包装（EnhancedCache 类型稳定）/ 提交三阶段协议
 * + 服务端错误回填 + 脚本钩子 beforeSubmit·afterSubmit·onActionClick + 错误汇总区。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Typography } from 'antd';
import {
  FormStore, SubmitGuard, DebouncedUniqueChecker, executeSubmit,
  type SubmitTransport,
} from '@schema/schema-form';
import { materialRegistry } from '@schema/schema-renderer';
import type { FieldSchema, PageSchema } from '@schema/schema-protocol';
import { RequestClient } from './request';
import { useScriptHooks } from './useScriptHooks';
import { SchemaRenderer, fieldRefOf, UnknownWidget } from './hostShared';

export default function SchemaFormPage({ client, page, fields, recordId, detailRow, onSubmitted }: {
  client: RequestClient;
  page: PageSchema;
  fields: FieldSchema[];
  recordId?: string | number;
  /** 编辑态详情记录（外层装载链一并拉取——构造期装载初值，零回填竞态）。 */
  detailRow: Record<string, unknown> | null;
  onSubmitted?: () => void;
}): React.ReactElement {
  const readOnly = page.type === 'DETAIL';
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
  // 错误汇总（M16 静默拦截修复）：布局外必填字段无法在页面上标红——
  // 在顶部汇总区明确列出字段名与提示，用户看得到拦截原因。
  const [errorSummary, setErrorSummary] = useState<
    { fieldKey: string; message: string; inLayout: boolean }[] | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  // 编辑态初值（M16 竞态修复）：detailRow 由外层装载链一并拉取传入，
  // 构造期直接装载进 store——取代原先组件内异步回填 effect。
  if (detailRow) {
    store.setValues(detailRow);
    store.refreshEffects();
  }

  // M14 页面脚本（08FE §4.3 调度点）：onLoad 挂载完成 / beforeSubmit·afterSubmit 提交前后
  const scripts = useScriptHooks({ page, store, client, recordId });
  // onLoad 挂载即触发（详情已随装载链就位，无回填等待）
  useEffect(() => {
    void scripts.onLoad();
  }, [scripts]);
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
    setErrorSummary(null);
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
        // 错误汇总（M16 静默拦截修复）：合并前端校验明细 + 服务端字段错误，
        // 区分布局内/外——布局外字段页面上没有输入位，只标红用户找不到位置，
        // 须在汇总区明确「该字段不在页面中」。
        const layoutKeys = new Set<string>();
        const visit = (nodes: PageSchema['layout']): void => {
          for (const n of nodes) {
            if (n.fieldRef !== undefined) layoutKeys.add(n.fieldRef);
            if (n.children) visit(n.children);
          }
        };
        visit(page.layout);
        const labelOf = (key: string): string =>
          store.fields.get(key)?.label || key;
        const summary: { fieldKey: string; message: string; inLayout: boolean }[] = [];
        const seen = new Set<string>();
        for (const e of result.clientErrors ?? []) {
          if (seen.has(e.fieldKey)) continue;
          seen.add(e.fieldKey);
          summary.push({ ...e, inLayout: layoutKeys.has(e.fieldKey) });
        }
        for (const [k, v] of Object.entries(serverFieldErrors)) {
          if (seen.has(k)) continue;
          seen.add(k);
          summary.push({ fieldKey: k, message: v, inLayout: layoutKeys.has(k) });
        }
        setErrorSummary(summary.map((e) => ({
          ...e,
          message: e.inLayout
            ? `${labelOf(e.fieldKey)}：${e.message}`
            : `${labelOf(e.fieldKey)}（不在页面中）：${e.message}——请联系管理员将该字段加入页面布局或调整必填设置`,
        })));
        if (result.globalError) setGlobalError(result.globalError);
        else if (summary.length === 0) setGlobalError('提交失败');
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
      {globalError ? <Alert type="error" showIcon closable message={globalError} style={{ marginBottom: 16 }} /> : null}
      {/* 错误汇总区（M16 静默拦截修复）：提交未通过时列出全部原因——
          布局外必填字段显式提示「不在页面中」，不再只有一条全局文案让用户猜位置 */}
      {errorSummary && errorSummary.length > 0 ? (
        <Alert
          type="error"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message={`提交未通过（${errorSummary.length} 项待处理）`}
          description={(
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {errorSummary.map((e) => <li key={e.fieldKey}>{e.message}</li>)}
            </ul>
          )}
        />
      ) : null}
      <SchemaRenderer
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
      />
      {!readOnly && <Button type="primary" loading={submitting} onClick={handleSubmit} style={{ marginTop: 16 }}>
        提交
      </Button>}
      {/* 自定义动作按钮（onActionClick 钩子调度点——08FE §4.3；CALL_API/OPEN_PAGE 等
          独立语义动作 P2 接线，P1 只渲染钩子可响应的动作按钮触发通知）。
          只读详情页保留 CUSTOM_SCRIPT/CALL_API 按钮（布局自带按钮仍可触发——脚本影响业务
          不因宿主隐藏提交而失效；DELETE 写操作只读态禁用）。 */}
      {page.actions.filter((a) => a.type === 'CUSTOM_SCRIPT' || a.type === 'CALL_API').map((a) => (
        <Button key={a.type + ('apiName' in a ? a.apiName : '')} style={{ marginTop: 16, marginLeft: 8 }}
          onClick={() => { void scripts.onActionClick('apiName' in a ? a.apiName : a.type); }}>
          {a.type === 'CALL_API' && 'apiName' in a ? `调用 ${a.apiName}` : a.type}
        </Button>
      ))}
    </Card>
  );
}
