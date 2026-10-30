/**
 * 联动编排（03FE §3 依赖编排算法）：
 * buildReactions 构建 fieldKey → 依赖它的字段集（反向邻接表）；
 * 字段 A 变化 → graph[A] 逐个触发 effect 重算（微任务批处理在 RenderScope 侧合并通知）。
 * 循环依赖：构建期检测成环抛错（设计态阻断保存——运行态由宿主 catch 降级忽略环上多余边）。
 */
import type { FieldSchema } from '@schema/schema-protocol';

export class ReactionGraph {
  /** 依赖字段 → 受影响字段集（反向边）。 */
  reverse = new Map<string, Set<string>>();

  /** 依赖字段变化时需要重算 effect 的目标字段集。 */
  dependentsOf(fieldKey: string): string[] {
    return [...(this.reverse.get(fieldKey) ?? [])];
  }

  /** 环检测（03FE §3：构建期成环 → 设计态报错阻断保存）。 */
  hasCycle(): string[] | null {
    // 对正向图（字段 → 其表达式的 dependsOn）做 DFS 环检测
    const forward = new Map<string, string[]>();
    for (const [dep, targets] of this.reverse) {
      for (const t of targets) {
        const list = forward.get(t) ?? [];
        list.push(dep);
        forward.set(t, list);
      }
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const path: string[] = [];
    let cycle: string[] | null = null;
    const visit = (node: string): void => {
      if (cycle) return;
      const c = color.get(node) ?? WHITE;
      if (c === GRAY) {
        const from = path.indexOf(node);
        cycle = path.slice(from);
        return;
      }
      if (c === BLACK) return;
      color.set(node, GRAY);
      path.push(node);
      for (const next of forward.get(node) ?? []) visit(next);
      path.pop();
      color.set(node, BLACK);
    };
    for (const node of forward.keys()) visit(node);
    return cycle;
  }
}

/** 四联动键位（03FE §3 表格的 Schema 字段位）。 */
const REACTION_KEYS = ['visibleWhen', 'disabledWhen', 'requiredWhen', 'optionsFilter'] as const;

/** 构建反向依赖图（03FE §3 buildReactions 算法）。 */
export function buildReactions(fields: FieldSchema[]): ReactionGraph {
  const graph = new ReactionGraph();
  const addEdge = (dep: string, target: string): void => {
    let set = graph.reverse.get(dep);
    if (!set) {
      set = new Set();
      graph.reverse.set(dep, set);
    }
    set.add(target);
  };
  for (const f of fields) {
    const ext = f as unknown as Record<string, unknown>;
    for (const key of REACTION_KEYS) {
      const binding = ext[key] as { dependsOn?: string[] } | undefined;
      if (!binding || !Array.isArray(binding.dependsOn)) continue;
      for (const dep of binding.dependsOn) addEdge(dep, f.key);
    }
  }
  return graph;
}
