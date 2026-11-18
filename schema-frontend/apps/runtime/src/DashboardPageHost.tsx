/**
 * 仪表盘宿主（spec 017 · 12FE §4 最小路径）：
 * - 消费 page.layout（SchemaRenderer 物料轨道渲染图表物料）；
 * - 数据装载：遍历 layout 收集图表节点的 props.dataSource（ChartDs）→ 逐节点调
 *   client.aggregate（请求体对齐后端 parseRequest）→ rows/chartLoading/chartError
 *   注入节点渲染 props；
 * - 三态：物料内部统一渲染 loading/error/empty（宿主只供给状态，不白屏）；
 * - 设计态复用：宿主不注入 rows 时物料渲染占位（设计器画布同组件）。
 */
import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { Card, Alert, Spin } from 'antd';
import { bindSchemaRenderer, materialRegistry, RenderScope } from '@schema/schema-renderer';
import type { PageSchema, FieldSchema, LayoutNode } from '@schema/schema-protocol';
import { isChartDs } from '@schema/component-materials';
import type { AggRow } from '@schema/chart-kit';
import { ServerError } from '@schema/schema-form';
import type { RequestClient } from './request';

const SchemaRenderer = bindSchemaRenderer({ createElement: React.createElement, useState, useEffect });

/** 图表节点装载态（按 nodeId 索引）。 */
type ChartState =
  | { phase: 'loading' }
  | { phase: 'done'; rows: AggRow[] }
  | { phase: 'error'; message: string };

/** layout 树收集：componentName 属图表物料且 props.dataSource 为 ChartDs 的节点。 */
function collectChartNodes(nodes: LayoutNode[], out: LayoutNode[] = []): LayoutNode[] {
  for (const n of nodes) {
    const meta = materialRegistry.get(n.componentName);
    if (meta?.group === '图表' && isChartDs(n.props?.dataSource)) out.push(n);
    if (n.children?.length) collectChartNodes(n.children, out);
  }
  return out;
}

export default function DashboardPageHost({ client, page, fields }: {
  client: RequestClient;
  page: PageSchema;
  fields: FieldSchema[];
}): React.ReactElement {
  const chartNodes = useMemo(() => collectChartNodes(page.layout ?? []), [page]);
  const [states, setStates] = useState<Record<string, ChartState>>({});
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const run = ++seq.current;
    setStates(Object.fromEntries(chartNodes.map((n) => [n.id, { phase: 'loading' } as ChartState])));
    for (const node of chartNodes) {
      const ds = node.props?.dataSource;
      if (!isChartDs(ds)) continue;
      const agg = ds.aggregate;
      client.aggregate(ds.modelId, {
        filter: ds.filter as never,
        measures: agg.measures,
        groupField: agg.group?.fieldKey,
        groupTopN: agg.group?.topN,
        bucketField: agg.timeBucket?.fieldKey,
        bucketInterval: agg.timeBucket?.interval,
      }).then((resp) => {
        if (cancelled || run !== seq.current) return;
        const rows = (resp as { rows?: AggRow[] })?.rows ?? [];
        setStates((s) => ({ ...s, [node.id]: { phase: 'done', rows } }));
      }).catch((e: unknown) => {
        if (cancelled || run !== seq.current) return;
        const message = e instanceof ServerError ? `${e.code}: ${e.message}`
          : e instanceof Error ? e.message : String(e);
        setStates((s) => ({ ...s, [node.id]: { phase: 'error', message } }));
      });
    }
    return () => { cancelled = true; };
  }, [client, chartNodes]);

  // 图表物料数据注入：包装 resolve 把节点装载态并进渲染 props
  const resolveComponent = useCallback((componentName: string) => {
    const meta = materialRegistry.get(componentName);
    const Comp = meta?.component as React.ComponentType<Record<string, unknown>> | undefined;
    if (!Comp) return undefined;
    if (meta?.group !== '图表') return Comp;
    const Injected = (props: Record<string, unknown>): React.ReactElement => {
      const nodeId = props['data-node-id'] as string;
      const st = states[nodeId];
      return (
        <Comp
          {...props}
          rows={st?.phase === 'done' ? st.rows : undefined}
          chartLoading={st?.phase === 'loading'}
          chartError={st?.phase === 'error' ? st.message : undefined}
        />
      );
    };
    return Injected;
  }, [states]);

  // 仪表盘只读无表单字段：空 RenderScope（表达式解析占位——图表物料不消费字段值）
  const scope = useMemo(() => new RenderScope(), []);
  return (
    <Card title={page.name} style={{ margin: '16px auto', maxWidth: 1080 }}>
      {chartNodes.length === 0 ? (
        <Alert type="info" showIcon message="空白仪表盘"
          description="在页面设计器中拖入图表物料并配置数据源后发布。" />
      ) : null}
      <SchemaRenderer
        page={page}
        scope={scope}
        fields={new Map(fields.map((f) => [f.key, f]))}
        resolveComponent={resolveComponent}
        react={{ createElement: React.createElement, useState, useEffect }}
      />
    </Card>
  );
}

/** 纯逻辑导出（单测位）：图表节点收集。 */
export { collectChartNodes };
