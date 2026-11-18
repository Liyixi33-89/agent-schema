/**
 * 表单页装配（M11 最小宿主核心；渐进重构第四批收敛为装载编排壳）：
 * 发布 PageSchema + 字段元数据 + 编辑态详情 一体化装载（M16 竞态修复——零回填竞态）
 * → migrate + validatePageSchema 协议校验 → 按页面类型分发：
 *   LIST → ListPageHost / DASHBOARD → DashboardPageHost / 其余 → SchemaFormPage。
 *
 * 装配边界（M11 定位）：本组件只做装载与装配——渲染归 M6 bindings、表单逻辑归 M7。
 * 共享工具拆至 hostShared（物料注册/工厂绑定/字段纯函数），渲染闭环拆至 SchemaFormPage。
 */
import React, { useEffect, useState } from 'react';
import { Alert, Spin } from 'antd';
import { ServerError } from '@schema/schema-form';
import { migrate, validatePageSchema, type FieldSchema, type PageSchema } from '@schema/schema-protocol';
import { RequestClient } from './request';
import { ensureMaterials, normalizeFields, validateLoadedFieldRefs } from './hostShared';
import ListPageHost from './ListPageHost';
import DashboardPageHost from './DashboardPageHost';
import SchemaFormPage from './SchemaFormPage';

/** 页面加载状态机。 */
type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'missing' }
  | { phase: 'ready'; page: PageSchema; fields: FieldSchema[]; detailRow: Record<string, unknown> | null };

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

  // 页面 Schema + 字段元数据 + 编辑态详情 一体化装载（M16 竞态修复）：
  // 此前详情在 SchemaFormPage 内异步回填——外层 effect 因缓存条目引用不稳定
  // 多余重跑时组件卸载，回填结果丢失且 detailLoaded 状态不再重置（表单页
  // hash 导航到详情路由时字段全空）。现把详情拉取合并进装载链：recordId
  // 参与 effect 依赖，同 key 重挂载时必然重新装载详情，一次到位零竞态。
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
        // DASHBOARD 页模型可空（PRD 02 §2.6「仪表盘可不选模型」——图表数据源存于
        // 节点 props.dataSource，页面级 modelId 仅作设计器字段下拉默认源）。
        if (!page?.modelId && page?.type !== 'DASHBOARD') {
          throw new ServerError('PAGE_INVALID', '页面未绑定数据模型');
        }
        // 字段元数据：绑定模型时装载（图表数据源配置字段下拉与展示格式消费）；
        // DASHBOARD 无模型时字段集为空数组（图表物料不依赖字段元数据渲染）。
        const fieldsRaw = page?.modelId ? await client.loadFields(page.modelId) : [];
        const fields = normalizeFields(fieldsRaw);
        if (page?.modelId) validateLoadedFieldRefs(page, fields);
        // 编辑态：详情记录一并装载（FORM 编辑 / DETAIL 查看；404 转终态缺失）
        // DASHBOARD 只读无记录态——recordId 场景不触发（裸页面路由带 ID 也走详情装载失败终态）。
        let detailRow: Record<string, unknown> | null = null;
        if (recordId != null && page?.modelId) {
          try {
            detailRow = (await client.detail(page.modelId, recordId)) as Record<string, unknown>;
          } catch (e) {
            if (e instanceof ServerError && e.code === 'NOT_FOUND') {
              if (!cancelled) setState({ phase: 'missing' });
              return;
            }
            throw e;
          }
        }
        if (cancelled) return;
        setState({ phase: 'ready', page, fields, detailRow });
      } catch (e) {
        if (cancelled) return;
        setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [client, pageId, etag, cachedSchema, recordId]);

  if (state.phase === 'loading') return <Spin tip="页面加载中..." />;
  if (state.phase === 'error') {
    return <Alert type="error" showIcon message="页面加载失败" description={state.message} />;
  }
  if (state.phase === 'missing') {
    return <DetailMissing />;
  }
  if (state.page.type === 'LIST') {
    return <ListPageHost key={pageId} client={client} page={state.page} fields={state.fields} />;
  }
  if (state.page.type === 'DASHBOARD') {
    // 仪表盘宿主（spec 017）：图表物料渲染 + 节点级聚合装载（三态不白屏）。
    return <DashboardPageHost key={pageId} client={client} page={state.page} fields={state.fields} />;
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
      detailRow={state.detailRow}
      onSubmitted={onSubmitted}
    />
  );
}

/** 详情不存在时不显示旧数据：详情加载 404 视为终态错误（区别于网络抖动可重试）。 */
function DetailMissing(): React.ReactElement {
  return <Alert type="warning" showIcon message="记录不存在" description="该记录可能已被删除，请返回列表刷新查看" />;
}

export { validateLoadedFieldRefs } from './hostShared';
export default FormPageHost;
