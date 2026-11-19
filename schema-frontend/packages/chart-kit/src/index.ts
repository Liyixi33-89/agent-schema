/**
 * ChartKit（12FE §2 最小实现）：ECharts 按需引入收口——物料组件不直接 import echarts。
 * - 按需注册：LineChart/BarChart + Grid/Tooltip（bundle 断言：无 `import * as echarts from 'echarts'` 全量引入）
 * - 受控生命周期：props.option 变化 setOption(notMerge=false) 增量更新；卸载 dispose
 * - resize 归并：ResizeObserver → rAF 合帧 → chart.resize()
 * - 本包对 react 保持零依赖红线：React 组件由 component-materials 注入 createElement 组装，
 *   数据映射（rows → option）为纯函数可直接单测。
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
// Renderer 必须显式注册：echarts/core 模式下注册表为空——缺省时 init() 内部
// `rendererCtors[mode]` 查找失败即 "l0[o] is not a constructor" 崩溃（spec 018 验收实测）
import { CanvasRenderer } from 'echarts/renderers';
import { AGGREGATE_FUNCS, TIME_BUCKET_INTERVALS, type AggregateRequest } from '@schema/schema-protocol';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

export { echarts };

/** 聚合行（后端 AggregateBuilder.toRows 形态——02BE §3.6 响应）。 */
export interface AggRow {
  bucket?: string;
  dimension?: unknown;
  values: { func: string; fieldKey: string; value: number | null }[];
}

/** 图表数据源（节点 props 内静态 JSON——协议合法面，aggregate 直接复用冻结 AggregateRequest）。 */
export interface ChartDs {
  modelId: string;
  aggregate: AggregateRequest;
  filter?: unknown;
}

/** ChartDs 结构判定（无 dataSource 或协议外形态时图表渲染设计态占位而非报错）。 */
export function isChartDs(v: unknown): v is ChartDs {
  if (typeof v !== 'object' || v === null) return false;
  const ds = v as Partial<ChartDs>;
  if (typeof ds.modelId !== 'string' || !ds.modelId) return false;
  const agg = ds.aggregate;
  if (typeof agg !== 'object' || agg === null) return false;
  if (!Array.isArray(agg.measures) || agg.measures.length === 0) return false;
  const funcs = AGGREGATE_FUNCS as readonly string[];
  if (!agg.measures.every((m) => typeof m?.fieldKey === 'string'
    && typeof m?.func === 'string' && funcs.includes(m.func))) return false;
  if (agg.timeBucket && !(TIME_BUCKET_INTERVALS as readonly string[]).includes(agg.timeBucket.interval)) return false;
  return true;
}

/** 首度量值提取（指标卡：无分组单度量聚合 → rows[0].values[0].value）。 */
export function metricValue(rows: AggRow[]): number | null {
  const first = rows[0]?.values?.[0];
  return typeof first?.value === 'number' ? first.value : null;
}

/** 维度标签：时间桶优先（bucket），分组次之（dimension），无维度返回 null。 */
function dimensionLabel(row: AggRow): string | null {
  if (typeof row.bucket === 'string') return row.bucket;
  if (row.dimension != null) return String(row.dimension);
  return null;
}

/**
 * 柱状/折线 option 映射（纯函数）：
 * - 分组（可含桶）：xAxis=dimension 标签，每度量一条 series；
 * - 纯时间桶：xAxis=bucket 时序（后端已 ORDER BY bucket ASC）；
 * - 无维度聚合：单点展示（单类别全量聚合值）。
 */
export function axisOption(kind: 'bar' | 'line', rows: AggRow[], title?: string): Record<string, unknown> {
  const labels = rows.map((r) => dimensionLabel(r) ?? '全部');
  const series = rows.length
    ? (rows[0].values ?? []).map((m, i) => ({
      name: `${m.func}(${m.fieldKey})`,
      type: kind,
      data: rows.map((r) => r.values?.[i]?.value ?? null),
    }))
    : [];
  return {
    title: title ? { text: title, left: 'center', textStyle: { fontSize: 14 } } : undefined,
    tooltip: { trigger: 'axis' },
    grid: { left: 48, right: 24, top: title ? 48 : 24, bottom: 32 },
    xAxis: { type: 'category', data: labels },
    yAxis: { type: 'value' },
    series,
  };
}
