/**
 * 列表宿主纯逻辑层（渐进重构第四批——自 ListPageHost.tsx 原样抽出，行为不变）：
 * - parseListResult：列表响应契约校验（list/total 包裹、有限整数 total）
 * - resolveOpenTarget：行跳转目标解析（OPEN_PAGE + queryMapping，坏值显式拒绝）
 * - findDataTable/DesignedColumn/renderCell：设计态列配置与单元格渲染
 */
import React from 'react';
import { Tag, Typography } from 'antd';
import type { FieldSchema, PageSchema } from '@schema/schema-protocol';

export function parseListResult(value: unknown): { list: Record<string, unknown>[]; total: number } {
  if (!value || typeof value !== 'object') throw new Error('列表响应格式错误');
  const result = value as Record<string, unknown>;
  // total 必须为非负有限整数（NaN/Infinity 不是合法总数——下游分页器会算出鬼页码）
  if (!Array.isArray(result.list)
    || typeof result.total !== 'number' || !Number.isFinite(result.total)
    || !Number.isInteger(result.total) || result.total < 0) {
    throw new Error('列表响应缺少 list 或 total');
  }
  if (result.list.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('列表记录格式错误');
  }
  return { list: result.list as Record<string, unknown>[], total: result.total };
}

/** 列表设计态列配置（DataTable props.columns——02PRD §2.5 列配置区）。 */
export interface DesignedColumn {
  fieldKey: string;
  title?: string;
  width?: number;
  fixed?: 'left' | 'right';
  format?: 'date' | 'amount' | 'enumTag';
}

export function findDataTable(page: PageSchema): { node: PageSchema['layout'][number] } | null {
  const walk = (nodes: PageSchema['layout']): PageSchema['layout'][number] | null => {
    for (const n of nodes) {
      if (n.componentName === 'DataTable') return n;
      if (n.children) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  const node = walk(page.layout);
  return node ? { node } : null;
}

/** recordId 合法值：非空、不含路径分隔符（生成 `#/page/:id/:recordId` 路由段）。 */
function validRecordId(value: string | number): boolean {
  const s = String(value);
  return s.length > 0 && !s.includes('/');
}

/** 行跳转目标解析：OPEN_PAGE 动作 + queryMapping（值来源行记录）。hash 基址可注入（测试）。
 *  M16 收口：不支持的表达式形态与坏值显式拒绝（bad-mapping），不再默默生成坏路由。 */
export function resolveOpenTarget(
  page: PageSchema, row: Record<string, unknown>, currentHash?: string,
): { ok: true; hash: string } | { ok: false; reason: 'no-action' | 'no-id' | 'bad-mapping' } {
  const action = page.actions.find((a): a is Extract<PageSchema['actions'][number], { type: 'OPEN_PAGE' }> => a.type === 'OPEN_PAGE');
  if (!action) return { ok: false, reason: 'no-action' };
  if (action.targetPageId == null || action.targetPageId === '') {
    return { ok: false, reason: 'bad-mapping' };
  }
  const recordId = action.queryMapping?.recordId;
  // queryMapping.recordId 支持字面量与 {kind:'field',source:'id'} 两形态；缺省取行 _id
  //（引擎投影键 _id——避开业务字段占用 id；兼容直出 id 的数据源）
  let rowId: string | number | undefined;
  if (recordId == null) {
    rowId = (row._id ?? row.id) as string | number | undefined;
  } else if (typeof recordId === 'object' && recordId !== null && (recordId as { kind?: string }).kind === 'field') {
    const src = (recordId as { source?: string }).source ?? '_id';
    rowId = row[src] as string | number | undefined;
  } else if (typeof recordId === 'string' || typeof recordId === 'number') {
    rowId = recordId;
  } else {
    // 对象/数组/布尔等不支持的字面量形态——明确拒绝
    return { ok: false, reason: 'bad-mapping' };
  }
  if (rowId == null) return { ok: false, reason: 'no-id' };
  if (typeof rowId !== 'string' && typeof rowId !== 'number') {
    return { ok: false, reason: 'bad-mapping' };
  }
  if (!validRecordId(rowId)) return { ok: false, reason: 'bad-mapping' };
  const hashBase = currentHash ?? (typeof location !== 'undefined' ? location.hash : '');
  const app = hashBase.match(/^#\/app\/(\d+)/);
  const hash = app
    ? `#/app/${app[1]}/page/${action.targetPageId}/${String(rowId)}`
    : `#/page/${action.targetPageId}/${String(rowId)}`;
  return { ok: true, hash };
}

/** 设计格式渲染（DesignedColumn.format——M16 接线：声明了就必须消费）。 */
function renderDesignedFormat(format: DesignedColumn['format'], value: unknown): string | null {
  if (value == null || value === '') return null;
  if (format === 'date') {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('zh-CN');
  }
  if (format === 'amount') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // enumTag 由 renderCell 的枚举分支处理（需要 enumOptions 标签映射）；此处不重复
  return null;
}

export function renderCell(
  field: FieldSchema | undefined, value: unknown,
  designed?: DesignedColumn, downloader?: (fileId: string) => Promise<string>,
): React.ReactNode {
  if (value == null || value === '') return '—';
  // 设计格式优先（设计者显式声明覆盖默认呈现）
  if (designed?.format && designed.format !== 'enumTag') {
    const formatted = renderDesignedFormat(designed.format, value);
    if (formatted != null) return formatted;
  }
  if (field?.type === 'enum' && field.enumOptions) {
    const hit = field.enumOptions.find((o) => o.value === value);
    return hit ? <Tag>{hit.label}</Tag> : String(value);
  }
  if (field?.type === 'file' && value && typeof value === 'object') {
    const meta = value as { fileId?: string; name?: string };
    if (meta.fileId && downloader) {
      // 附件交互闭环：点击换一次性下载 URL 再打开（11BE §3.2 同租户校验）
      return (
        <Typography.Link onClick={() => {
          void downloader(String(meta.fileId)).then((url) => { window.open(url, '_blank'); });
        }}>{meta.name ?? '附件'}</Typography.Link>
      );
    }
    return meta.name ? <Typography.Text>{meta.name}</Typography.Text> : '附件';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (field?.type === 'number' && typeof value === 'number') {
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  return String(value);
}
