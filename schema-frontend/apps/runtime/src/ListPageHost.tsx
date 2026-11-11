import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Table } from 'antd';
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

export default function ListPageHost({ client, page, fields }: {
  client: RequestClient; page: PageSchema; fields: FieldSchema[];
}): React.ReactElement {
  const binding = page.dataSource;
  const detailAction = page.actions.find(action => action.type === 'OPEN_PAGE');
  const [pagination, setPagination] = useState({
    page: binding?.pagination?.page ?? 1, size: binding?.pagination?.size ?? 20,
  });
  const [result, setResult] = useState<{ list: Record<string, unknown>[]; total: number }>({ list: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client.query(page.modelId!, {
      filter: binding?.filter, sort: binding?.sort,
      fields: fields.map(field => field.key), ...pagination,
    }).then(value => {
      const parsed = parseListResult(value);
      if (!cancelled) setResult(parsed);
    }).catch(e => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, page.modelId, binding, fields, pagination, retry]);
  return <Card title={page.name}>
    {error && <Alert type="error" showIcon message="列表加载失败" description={error}
      action={<Button onClick={() => setRetry(value => value + 1)}>重试</Button>} />}
    <Table<Record<string, unknown>> loading={loading} rowKey={row => String(row.id)}
      onRow={row => ({ onDoubleClick: () => {
        if (detailAction?.type !== 'OPEN_PAGE' || row.id == null) return;
        const app = location.hash.match(/^#\/app\/(\d+)/);
        location.hash = app
          ? `#/app/${app[1]}/page/${detailAction.targetPageId}/${String(row.id)}`
          : `#/page/${detailAction.targetPageId}/${String(row.id)}`;
      } })}
      dataSource={error ? [] : result.list}
      columns={fields.map(field => ({ title: field.label, dataIndex: field.key, key: field.key,
        render: (value: unknown) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value),
      }))}
      pagination={{ current: pagination.page, pageSize: pagination.size, total: result.total,
        onChange: (pageNumber, size) => setPagination({ page: pageNumber, size }), }} />
  </Card>;
}
