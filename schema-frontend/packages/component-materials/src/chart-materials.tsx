/**
 * 图表物料 3 个（12FE §3 最小子集，spec 017）：
 * MetricCard（数值卡·纯 AntD）/ BarChart / LineChart（经 chart-kit ECharts 封装）。
 * 数据装载由宿主（DashboardPageHost）完成——物料只消费注入的 rows/装载态，
 * 不自发请求（设计态画布复用同一组件，宿主不注入 rows 时渲染占位）。
 * 薄封装纪律与基础物料一致：props → AntD/ECharts option 翻译，无内部业务状态。
 */
import React, { useRef, useEffect } from 'react';
import { Card, Alert, Statistic, Empty, Spin, Button } from 'antd';
import type { MaterialMeta } from '@schema/schema-renderer';
import { echarts, axisOption, metricValue, isChartDs, type AggRow } from '@schema/chart-kit';

/** 与 index.tsx WidgetProps 同构（循环导入规避：图表物料独立声明受控契约）。 */
export interface ChartWidgetProps {
  value?: unknown;
  onChange?: (value: unknown) => void;
  label?: string;
  title?: string;
  unit?: string;
  dataSource?: unknown;
  /** 宿主注入的聚合结果（运行时装载完成态）；设计态缺省。 */
  rows?: AggRow[];
  /** 宿主注入的装载态（运行时 true=请求中）。 */
  chartLoading?: boolean;
  /** 宿主注入的装载错误（运行时失败态——Card 内回显不白屏）。 */
  chartError?: string;
  onChartRetry?: () => void;
  [key: string]: unknown;
}

/** ECharts 受控容器（12FE §2 ②③）：option 增量更新 + dispose + resize 归并。 */
function ChartCanvas({ option }: { option: Record<string, unknown> }): React.ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const frame = useRef<number>(0);
  // 上次 setOption 的 series 数（配置变化残留防护：series 数量减少时增量合并会保留
  // 旧 series——按数量差切换 notMerge 全量替换，数量不变仍走增量合并保留交互态）
  const seriesCount = useRef<number>(-1);

  useEffect(() => {
    if (!holder.current) return;
    const inst = echarts.init(holder.current);
    chart.current = inst;
    const ro = new ResizeObserver(() => {
      // rAF 合帧（12FE §2 ③）：栅格拖拽宽度变化每帧只 resize 一次
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        inst.resize();
      });
    });
    ro.observe(holder.current);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      ro.disconnect();
      inst.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const inst = chart.current;
    if (!inst) return;
    const next = Array.isArray(option.series) ? (option.series as unknown[]).length : 0;
    const notMerge = next !== seriesCount.current;
    seriesCount.current = next;
    inst.setOption(option, { notMerge });
  }, [option]);

  return <div ref={holder} style={{ width: '100%', height: 260 }} />;
}

/** 三态统一壳：loading → Spin；error → Alert；empty → Empty 占位。 */
function ChartShell({ title, loading, error, empty, children, onRetry }: {
  title?: string; loading?: boolean; error?: string; empty?: boolean; children?: React.ReactNode; onRetry?: () => void;
}): React.ReactElement {
  return (
    <Card title={title} size="small" style={{ marginBottom: 12 }}>
      {error ? <Alert type="error" showIcon message="数据加载失败" description={error} action={onRetry ? <Button onClick={onRetry}>重试</Button> : undefined} /> : null}
      {!error && loading ? <div style={{ padding: '32px 0', textAlign: 'center' }}><Spin /></div> : null}
      {!error && !loading && empty ? <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
      {!error && !loading && !empty ? children : null}
    </Card>
  );
}

function makeAxisWidget(kind: 'bar' | 'line'): React.ComponentType<ChartWidgetProps> {
  const Widget = (p: ChartWidgetProps): React.ReactElement => {
    const rows = p.rows;
    const ds = p.dataSource;
    const option = React.useMemo(
      () => axisOption(kind, rows ?? [], typeof p.title === 'string' ? p.title : undefined),
      [rows, p.title],
    );
    return (
      <ChartShell
        title={typeof p.title === 'string' ? p.title : undefined}
        loading={!!p.chartLoading}
        error={p.chartError}
        onRetry={p.onChartRetry}
        empty={!rows?.length}
      >
        <ChartCanvas option={option} />
      </ChartShell>
    );
  };
  return Widget;
}

const MetricCardWidget = (p: ChartWidgetProps): React.ReactElement => {
  const rows = p.rows;
  const value = rows ? metricValue(rows) : null;
  return (
    <ChartShell
      title={typeof p.title === 'string' ? p.title : undefined}
      loading={!!p.chartLoading}
      error={p.chartError}
        onRetry={p.onChartRetry}
      empty={!rows?.length}
    >
      <Statistic value={value ?? 0} suffix={typeof p.unit === 'string' ? p.unit : undefined} />
    </ChartShell>
  );
};

const chartWidgets: Record<string, React.ComponentType<ChartWidgetProps>> = {
  MetricCard: MetricCardWidget,
  BarChart: makeAxisWidget('bar'),
  LineChart: makeAxisWidget('line'),
};

const CHART_DEFS = [
  { componentName: 'MetricCard', group: '图表', icon: 'dashboard' },
  { componentName: 'BarChart', group: '图表', icon: 'bar-chart' },
  { componentName: 'LineChart', group: '图表', icon: 'line-chart' },
] as const;

export const CHART_MATERIALS: MaterialMeta[] = CHART_DEFS.map((m) => ({
  componentName: m.componentName,
  runtime: 'dynamic' as const,
  group: m.group,
  icon: m.icon,
  component: chartWidgets[m.componentName],
}));

/** 一次性注册图表物料（宿主启动时与基础物料一同调用）。 */
export function registerChartMaterials(target: import('@schema/schema-renderer').MaterialRegistry): void {
  for (const m of CHART_MATERIALS) target.register(m);
}

export { isChartDs };
