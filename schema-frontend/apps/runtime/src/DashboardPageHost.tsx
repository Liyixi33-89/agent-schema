/**
 * 仪表盘宿主（spec 017 · 12FE §4 最小路径；018 收口——装载状态机抽至 chartLoad.ts）：
 * - 消费 page.layout（SchemaRenderer 物料轨道渲染图表物料）；
 * - 数据装载：ChartLoadCoordinator（取消/竞态/重试语义单测覆盖），本组件只做
 *   React 接线——states 进 ChartContext，物料经 context 消费不重挂载；
 * - 设计态复用：宿主不注入 rows 时物料渲染占位（设计器画布同组件）。
 */
import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { Card, Alert } from 'antd';
import { bindSchemaRenderer, materialRegistry, RenderScope } from '@schema/schema-renderer';
import type { PageSchema, FieldSchema, LayoutNode } from '@schema/schema-protocol';
import { isChartDs } from '@schema/component-materials';
import { ChartLoadCoordinator, type ChartState } from './chartLoad';
import type { RequestClient } from './request';

const SchemaRenderer = bindSchemaRenderer({ createElement: React.createElement, useState, useEffect });
const ChartContext = React.createContext<{
  states: Record<string, ChartState>;
  retryNode: (nodeId: string) => void;
}>({ states: {}, retryNode: () => {} });

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

  // 协调器生命周期与宿主一致；aggregate 通道经 ref 稳定引用（client 不变）。
  // filter 经通道内收窄：ChartDs.filter 为协议静态 JSON（FilterNode 形态由后端校验）
  const clientRef = useRef(client);
  clientRef.current = client;
  const coordinator = useMemo(() => new ChartLoadCoordinator((modelId, body, options) =>
    clientRef.current.aggregate(modelId, { ...body, filter: body.filter as import('@schema/schema-protocol').FilterNode }, options)), []);
  useEffect(() => () => coordinator.dispose(), [coordinator]);

  const setNode = useCallback((nodeId: string, state: ChartState) => {
    setStates((s) => ({ ...s, [nodeId]: state }));
  }, []);

  useEffect(() => {
    const nodes: { id: string; ds: import('@schema/chart-kit').ChartDs }[] = [];
    for (const n of chartNodes) {
      const ds = n.props?.dataSource;
      if (isChartDs(ds)) nodes.push({ id: n.id, ds });
    }
    coordinator.begin(nodes, setNode);
  }, [coordinator, chartNodes, setNode]);

  const retryNode = useCallback((nodeId: string) => {
    const node = chartNodes.find((item) => item.id === nodeId);
    const ds = node?.props?.dataSource;
    if (!isChartDs(ds)) return;
    coordinator.retry(nodeId, ds, setNode);
  }, [coordinator, chartNodes, setNode]);

  const componentCache = useMemo(() => new Map<string, React.ComponentType<Record<string, unknown>>>(), []);
  const chartContext = useMemo(() => ({ states, retryNode }), [states, retryNode]);
  // 状态通过 context 更新，缓存组件类型避免 ECharts 每次响应重挂载。
  const resolveComponent = useCallback((componentName: string) => {
    const cached = componentCache.get(componentName);
    if (cached) return cached;
    const meta = materialRegistry.get(componentName);
    const Comp = meta?.component as React.ComponentType<Record<string, unknown>> | undefined;
    if (!Comp) return undefined;
    if (meta?.group !== '图表') return Comp;
    const Injected = (props: Record<string, unknown>): React.ReactElement => {
      const context = React.useContext(ChartContext);
      const nodeId = props['data-node-id'] as string;
      const st = context.states[nodeId];
      return (
        <Comp
          {...props}
          rows={st?.phase === 'done' ? st.rows : undefined}
          chartLoading={st?.phase === 'loading'}
          chartError={st?.phase === 'error' ? st.message : undefined}
          onChartRetry={() => context.retryNode(nodeId)}
        />
      );
    };
    componentCache.set(componentName, Injected);
    return Injected;
  }, [componentCache]);

  // 仪表盘只读无表单字段：空 RenderScope（表达式解析占位——图表物料不消费字段值）
  const scope = useMemo(() => new RenderScope(), []);
  return (
    <Card title={page.name} style={{ margin: '16px auto', maxWidth: 1080 }}>
      {chartNodes.length === 0 ? (
        <Alert type="info" showIcon message="空白仪表盘"
          description="在页面设计器中拖入图表物料并配置数据源后发布。" />
      ) : null}
      <ChartContext.Provider value={chartContext}>
      <SchemaRenderer
        page={page}
        scope={scope}
        fields={new Map(fields.map((f) => [f.key, f]))}
        resolveComponent={resolveComponent}
        react={{ createElement: React.createElement, useState, useEffect }}
      />
      </ChartContext.Provider>
    </Card>
  );
}

/** 纯逻辑导出（单测位）：图表节点收集。 */
export { collectChartNodes };
