/**
 * 列表页装配（M15 2026-11-11 重写——消费设计布局而非模型全字段直出）：
 * - 布局真源 page.layout：找 DataTable 节点消费其 props.columns（设计态列配置）；
 *   无列配置时退化按绑定字段生成（布局缺省容错，不算「设计器设计什么呈现什么」的正路径）。
 * - 数据源一致性：page.modelId 与 dataSource.modelId 不同时以 dataSource.modelId 为准并告警提示。
 * - 权限字段边界：列只取 fields（服务端权限过滤后的可见集）内字段——
 *   布局配置了不可见字段时静默剔除该列（不因设计配置越权展示）。
 * - 分页/过滤/排序：dataSource.filter/sort 初值 + antd Table 分页变化重查；
 *   排序点击映射 sort 参数（服务端排序）。
 * - 行跳转：消费 OPEN_PAGE 动作（可能多条——取第一条；P1 不做多动作编排），
 *   queryMapping 支持 {recordId: {kind:'field',source:'id'}} 形态把行值映射进路由参数；
 *   异常路径：无 ID 行 / 目标页缺失时行内提示，不抛全局错误。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { FieldSchema, PageSchema } from '@schema/schema-protocol';
import { RequestClient } from './request';

export function parseListResult(value: unknown): { list: Record<string, unknown>[]; total: number } {
  if (!value || typeof value !== 'object') throw new Error('列表响应格式错误');
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.list) || typeof result.total !== 'number' || result.total < 0) {
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

function findDataTable(page: PageSchema): { node: PageSchema['layout'][number] } | null {
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

/** 行跳转目标解析：OPEN_PAGE 动作 + queryMapping（值来源行记录）。hash 基址可注入（测试）。 */
export function resolveOpenTarget(
  page: PageSchema, row: Record<string, unknown>, currentHash?: string,
): { ok: true; hash: string } | { ok: false; reason: 'no-action' | 'no-id' } {
  const action = page.actions.find((a): a is Extract<PageSchema['actions'][number], { type: 'OPEN_PAGE' }> => a.type === 'OPEN_PAGE');
  if (!action) return { ok: false, reason: 'no-action' };
  const recordId = action.queryMapping?.recordId;
  // queryMapping.recordId 支持字面量与 {kind:'field',source:'id'} 两形态；缺省取行 _id
  //（引擎投影键 _id——避开业务字段占用 id；兼容直出 id 的数据源）
  let rowId: string | number | undefined;
  if (recordId == null) {
    rowId = (row._id ?? row.id) as string | number | undefined;
  } else if (typeof recordId === 'object' && recordId !== null && (recordId as { kind?: string }).kind === 'field') {
    const src = (recordId as { source?: string }).source ?? '_id';
    rowId = row[src] as string | number | undefined;
  } else {
    rowId = recordId as string | number;
  }
  if (rowId == null) return { ok: false, reason: 'no-id' };
  const hashBase = currentHash ?? (typeof location !== 'undefined' ? location.hash : '');
  const app = hashBase.match(/^#\/app\/(\d+)/);
  const hash = app
    ? `#/app/${app[1]}/page/${action.targetPageId}/${String(rowId)}`
    : `#/page/${action.targetPageId}/${String(rowId)}`;
  return { ok: true, hash };
}

function renderCell(field: FieldSchema | undefined, value: unknown): React.ReactNode {
  if (value == null || value === '') return '—';
  if (field?.type === 'enum' && field.enumOptions) {
    const hit = field.enumOptions.find((o) => o.value === value);
    return hit ? <Tag>{hit.label}</Tag> : String(value);
  }
  if (field?.type === 'file' && value && typeof value === 'object') {
    const meta = value as { name?: string };
    return meta.name ? <Typography.Link>{meta.name}</Typography.Link> : '附件';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (field?.type === 'number' && typeof value === 'number') {
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  return String(value);
}

export default function ListPageHost({ client, page, fields }: {
  client: RequestClient; page: PageSchema; fields: FieldSchema[];
}): React.ReactElement {
  const binding = page.dataSource;
  // 数据源一致性：页面模型与绑定模型不一致以绑定为准（提示可见——接线错误不该静默）
  const queryModelId = binding?.modelId ?? page.modelId!;
  const modelMismatch = binding?.modelId != null && page.modelId != null && binding.modelId !== page.modelId;

  const dataTable = useMemo(() => findDataTable(page), [page]);
  const designedColumns = (dataTable?.node.props.columns as DesignedColumn[] | undefined) ?? undefined;

  // 权限字段边界：可见字段集（fields 为服务端权限过滤后元数据）
  const visibleKeys = useMemo(() => new Set(fields.map((f) => f.key)), [fields]);
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  const columns: ColumnsType<Record<string, unknown>> = useMemo(() => {
    const base = designedColumns && designedColumns.length
      // 设计列顺序真源；越权字段静默剔除（权限边界优先于设计配置）
      ? designedColumns.filter((c) => visibleKeys.has(c.fieldKey)).map((c) => ({
        title: c.title ?? fieldByKey.get(c.fieldKey)?.label ?? c.fieldKey,
        dataIndex: c.fieldKey, key: c.fieldKey,
        width: c.width, fixed: c.fixed,
      }))
      // 布局缺省容错：按可见字段全量生成（与权限边界一致）
      : fields.map((f) => ({ title: f.label, dataIndex: f.key, key: f.key }));
    return base.map((col) => ({
      ...col,
      render: (value: unknown) => renderCell(fieldByKey.get(String(col.key)), value),
    }));
  }, [designedColumns, fields, visibleKeys, fieldByKey]);

  const hasOpenAction = page.actions.some((a) => a.type === 'OPEN_PAGE');

  const [pagination, setPagination] = useState({
    page: binding?.pagination?.page ?? 1, size: binding?.pagination?.size ?? 20,
  });
  const [sorter, setSorter] = useState<{ field: string; order: 'asc' | 'desc' }[] | undefined>(binding?.sort);
  // 服务端排序映射到表格列头（呈现排序态）；_id 代理列不可排序（引擎白名单外）
  const [sortState, setSortState] = useState<{ columnKey: string; order: 'ascend' | 'descend' | undefined }>(() =>
    binding?.sort?.length ? { columnKey: binding.sort[0].field, order: binding.sort[0].order === 'asc' ? 'ascend' : 'descend' } : { columnKey: '', order: undefined });
  const [result, setResult] = useState<{ list: Record<string, unknown>[]; total: number }>({ list: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowHint, setRowHint] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client.query(queryModelId, {
      filter: binding?.filter, sort: sorter,
      fields: fields.map(field => field.key), ...pagination,
    }).then(value => {
      const parsed = parseListResult(value);
      if (!cancelled) setResult(parsed);
    }).catch(e => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, queryModelId, binding, fields, pagination, sorter, retry]);

  const openRow = (row: Record<string, unknown>): void => {
    const target = resolveOpenTarget(page, row);
    if (!target.ok) {
      setRowHint(target.reason === 'no-action' ? '本页未配置打开页面动作' : '该行缺少记录 ID，无法跳转');
      return;
    }
    setRowHint(null);
    location.hash = target.hash;
  };

  return <Card title={page.name}>
    {modelMismatch && (
      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message="页面模型与数据源绑定模型不一致，已按数据源绑定查询" />
    )}
    {error && <Alert type="error" showIcon message="列表加载失败" description={error}
      action={<Button onClick={() => setRetry(value => value + 1)}>重试</Button>} />}
    {rowHint && <Alert type="info" showIcon closable message={rowHint} style={{ marginBottom: 12 }}
      onClose={() => setRowHint(null)} />}
    <Table<Record<string, unknown>> loading={loading} rowKey={row => String(row._id ?? row.id)}
      onRow={row => ({
        onDoubleClick: () => openRow(row),
        onClick: () => { /* 单击不定跳转——双击/操作列入口，避免误触 */ },
      })}
      dataSource={error ? [] : result.list}
      columns={(() => {
        const ops = hasOpenAction ? [...columns, {
          key: '__open__', title: '操作', width: 90, fixed: 'right' as const,
          render: (_v: unknown, row: Record<string, unknown>) => (
            <Space size={4}>
              <Button type="link" size="small" onClick={() => openRow(row)}>打开</Button>
            </Space>
          ),
        }] : columns;
        // 服务端排序映射列头排序态（设计态 binding.sort 初值 + 点击切换重查）
        return ops.map((c) => visibleKeys.has(String(c.key))
          ? { ...c, sorter: true, sortOrder: sortState.columnKey === c.key ? sortState.order ?? null : null }
          : { ...c, sorter: false });
      })()}
      onChange={(_pg, _fil, sort) => {
        const next = Array.isArray(sort) ? sort : [sort];
        const mapped = next
          .filter((s) => s.order && s.field != null)
          .map((s) => ({ field: String(s.field), order: s.order === 'ascend' ? 'asc' as const : 'desc' as const }));
        setSorter(mapped.length ? mapped : undefined);
        setSortState(mapped.length
          ? { columnKey: mapped[0].field, order: mapped[0].order === 'asc' ? 'ascend' : 'descend' }
          : { columnKey: '', order: undefined });
      }}
      pagination={{ current: pagination.page, pageSize: pagination.size, total: result.total,
        showSizeChanger: true,
        onChange: (pageNumber, size) => setPagination({ page: pageNumber, size }), }} />
  </Card>;
}
