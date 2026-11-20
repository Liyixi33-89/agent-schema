/**
 * 仪表盘图表装载状态机（spec 018 收口——纯逻辑抽离，宿主 UI 零依赖）：
 * - 取消语义：每轮装载持独立 AbortController；卸载/chartNodes 变更整轮 abort，
 *   AbortError 静默丢弃（不进错误态——页面切换不是故障）；
 * - 竞态防护：世代号（run seq）+ 节点请求序——旧响应晚到不覆盖新状态；
 * - 节点重试：错误节点按 nodeId 重发，装载中节点重试幂等（先 abort 旧请求），
 *   不动其他节点状态；
 * - 响应契约：非 {rows: AggRow[]} 形态按错误处理（后端包裹结构漂移不静默白屏）。
 * 宿主（DashboardPageHost）只做 React 接线；本模块全部逻辑可直接单测。
 */
import type { AggRow, ChartDs } from '@schema/chart-kit';

/** 单节点装载态。 */
export type ChartState =
  | { phase: 'loading' }
  | { phase: 'done'; rows: AggRow[] }
  | { phase: 'error'; message: string };

export interface AggregateFn {
  (modelId: string, body: AggRequestBody, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** ChartDs → 后端 parseRequest 请求体（字段名对齐 02BE §3.6）。 */
export interface AggRequestBody {
  filter?: unknown;
  measures: { fieldKey: string; func: string }[];
  groupField?: string;
  groupTopN?: number;
  bucketField?: string;
  bucketInterval?: string;
}

export function aggBody(ds: ChartDs): AggRequestBody {
  return {
    filter: ds.filter,
    measures: ds.aggregate.measures,
    groupField: ds.aggregate.group?.fieldKey,
    groupTopN: ds.aggregate.group?.topN,
    bucketField: ds.aggregate.timeBucket?.fieldKey,
    bucketInterval: ds.aggregate.timeBucket?.interval,
  };
}

/** 错误文案归一：ServerError 形态带 code，AbortError 归 null（取消不进错误态）。 */
export function errorOf(e: unknown): string | null {
  if (e instanceof Error && e.name === 'AbortError') return null;
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    return `${(e as { code: unknown }).code}: ${(e as { message: unknown }).message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * 装载协调器：一个宿主实例一份；页面切换换新世代，世代内节点级请求登记。
 * 不持有 React 状态——回调 setNode 由宿主注入（单测注入收集器即可断言）。
 */
export class ChartLoadCoordinator {
  private run = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly retryControllers = new Map<string, AbortController>();
  private disposed = false;

  constructor(private readonly aggregate: AggregateFn) {}

  /** 新一轮整页装载（chartNodes 变更/挂载时调用）：递增世代，整页重置 loading。 */
  begin(nodes: { id: string; ds: ChartDs }[], setNode: (nodeId: string, state: ChartState) => void): void {
    this.run += 1;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const node of nodes) {
      setNode(node.id, { phase: 'loading' });
      this.fetchNode(node.id, node.ds, this.run, this.controllers, setNode);
    }
  }

  /** 单节点重试：先 abort 该节点旧请求再重发；其他节点状态不受影响。 */
  retry(nodeId: string, ds: ChartDs, setNode: (nodeId: string, state: ChartState) => void): void {
    if (this.disposed) return;
    this.retryControllers.get(nodeId)?.abort();
    const controller = new AbortController();
    this.retryControllers.set(nodeId, controller);
    setNode(nodeId, { phase: 'loading' });
    this.fetchNode(nodeId, ds, this.run, this.retryControllers, setNode);
  }

  private fetchNode(
    nodeId: string, ds: ChartDs, run: number,
    pool: Map<string, AbortController>, setNode: (nodeId: string, state: ChartState) => void,
  ): void {
    const controller = new AbortController();
    pool.set(nodeId, controller);
    this.aggregate(ds.modelId, aggBody(ds), { signal: controller.signal })
      .then((resp) => {
        if (controller.signal.aborted || run !== this.run) return;
        const rows = (resp as { rows?: AggRow[] })?.rows;
        if (!Array.isArray(rows)) throw new Error('聚合响应缺少 rows');
        setNode(nodeId, { phase: 'done', rows });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || run !== this.run) return;
        const message = errorOf(e);
        if (message == null) return;
        setNode(nodeId, { phase: 'error', message });
      })
      .finally(() => {
        if (pool.get(nodeId) === controller) pool.delete(nodeId);
      });
  }

  /** 卸载：abort 全部在途请求并停摆（后续 retry 静默拒绝）。 */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const controller of this.retryControllers.values()) controller.abort();
    this.controllers.clear();
    this.retryControllers.clear();
  }
}
