/**
 * 列表页装配（M15 2026-11-11 重写——消费设计布局而非模型全字段直出；2026-11-17 审查收口）：
 * - 布局真源 page.layout：找 DataTable 节点消费其 props.columns（设计态列配置）；
 *   无列配置时退化按绑定字段生成（布局缺省容错，不算「设计器设计什么呈现什么」的正路径）。
 *   支持边界（M16 审查定版）：只消费第一个 DataTable + Card 包裹布局——周边节点与其他
 *   表格不渲染，页面头部 Alert 显式声明该边界，不静默冒充完整布局渲染。
 * - 数据源一致性（M16 审查收口）：page.modelId 与 dataSource.modelId 不一致时**拒绝渲染**
 *   （此前按 dataSource 查询 + 宿主 fields 投影混用两套元数据——fields 属 page.modelId 时
 *   列投影错位/数据解释错误）。接线错误在装载层修复，不做降级混搭。
 * - 权限字段边界：列只取 fields（服务端权限过滤后的可见集）内字段——
 *   布局配置了不可见字段时静默剔除该列（不因设计配置越权展示）。
 * - DesignedColumn.format 接线：date/amount/enumTag 三格式按声明渲染（此前声明未消费）。
 * - 分页/过滤/排序：dataSource.filter/sort 初值 + antd Table 分页变化重查；
 *   绑定（page 对象）变化时分页/排序状态重置回初值（此前保留旧状态错位查询）。
 * - 行跳转：消费 OPEN_PAGE 动作（可能多条——取第一条；P1 不做多动作编排），
 *   queryMapping 支持 {recordId: {kind:'field',source:'id'}} 形态把行值映射进路由参数；
 *   recordId 值校验（M16 收口）：空串/含斜杠/非（字符串|数字|field 引用）形态明确拒绝，
 *   不生成无法解析的坏路由；异常路径行内提示，不抛全局错误。
 * - 附件列：点击经宿主 downloader 换取一次性下载 URL 后打开（不再是纯外观链接）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { FieldSchema, PageSchema } from '@schema/schema-protocol';
import { RequestClient } from './request';

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

function renderCell(
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

export default function ListPageHost({ client, page, fields, downloader }: {
  client: RequestClient; page: PageSchema; fields: FieldSchema[];
  /** 附件下载凭证获取（缺省用 client.attachmentDownloadUrl）。 */
  downloader?: (fileId: string) => Promise<string>;
}): React.ReactElement {
  const binding = page.dataSource;
  // 数据源一致性（M16 审查收口）：模型不一致直接拒绝渲染——
  // 查询走 dataSource.modelId 而投影/列/格式用宿主 fields（属 page.modelId）是两套元数据混用，
  // 字段不存在、列为空、数据解释错误都由此产生。接线错误须在装载层修复，不降级混搭。
  const queryModelId = binding?.modelId ?? page.modelId!;
  const modelMismatch = binding?.modelId != null && page.modelId != null && binding.modelId !== page.modelId;
  if (modelMismatch) {
    return (
      <Card title={page.name}>
        <Alert type="error" showIcon message="页面配置错误：数据源绑定模型与页面模型不一致"
          description={`页面绑定模型 ${page.modelId}，数据源绑定模型 ${binding?.modelId}。列表查询与字段元数据必须同源，请在设计器中修正页面配置后重新发布。`} />
      </Card>
    );
  }

  const dataTable = useMemo(() => findDataTable(page), [page]);
  const designedColumns = (dataTable?.node.props.columns as DesignedColumn[] | undefined) ?? undefined;
  const designedByKey = useMemo(() => new Map(designedColumns?.map((c) => [c.fieldKey, c]) ?? []),
    [designedColumns]);
  const resolveDownloader = downloader ?? ((fileId: string) => client.attachmentDownloadUrl(fileId));

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
      render: (value: unknown) => renderCell(
        fieldByKey.get(String(col.key)), value,
        designedByKey.get(String(col.key)), resolveDownloader,
      ),
    }));
  }, [designedColumns, fields, visibleKeys, fieldByKey, designedByKey, resolveDownloader]);

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

  // 绑定变化（同组件实例复用渲染新 page 配置）时分页/排序重置回绑定初值——
  // 旧状态保留会带着上一页面的页码/排序查询新模型（结果错位）。
  useEffect(() => {
    setPagination({ page: binding?.pagination?.page ?? 1, size: binding?.pagination?.size ?? 20 });
    setSorter(binding?.sort);
    setSortState(binding?.sort?.length
      ? { columnKey: binding.sort[0].field, order: binding.sort[0].order === 'asc' ? 'ascend' : 'descend' }
      : { columnKey: '', order: undefined });
  }, [binding]);

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
      setRowHint(target.reason === 'no-action'
        ? '本页未配置打开页面动作'
        : target.reason === 'no-id'
          ? '该行缺少记录 ID，无法跳转'
          : '跳转配置无效（recordId 映射为空值或非法形态），请检查页面动作配置');
      return;
    }
    setRowHint(null);
    location.hash = target.hash;
  };

  // 布局支持边界声明：只消费第一个 DataTable + Card 包裹；周边节点/其他表格不渲染
  const layoutNodes = page.layout.length;
  const multiTable = layoutNodes > 1 || (dataTable != null && page.layout.length > 1);

  return <Card title={page.name}>
    {multiTable && (
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="当前版本渲染页面中的第一个数据表格；其余布局节点暂不展示" />
    )}
    {error && <Alert type="error" showIcon message="列表加载失败" description={error}
      action={<Button onClick={() => setRetry(value => value + 1)}>重试</Button>} />}
    {rowHint && <Alert type="info" showIcon closable message={rowHint} style={{ marginBottom: 12 }}
      onClose={() => setRowHint(null)} />}
    <Table<Record<string, unknown>> loading={loading} rowKey={(row) => {
      const id = row._id ?? row.id;
      // 行 ID 缺失时不静默兜底（重复 rowKey 会引发 React 键冲突与行选中错乱）——
      // 抛给 error 通道提示数据异常
      if (id == null) throw new Error('列表记录缺少 _id/id，无法渲染行键');
      return String(id);
    }}
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
