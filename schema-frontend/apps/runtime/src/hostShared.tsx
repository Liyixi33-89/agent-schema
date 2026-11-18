/**
 * 表单宿主共享层（渐进重构第四批——自 FormPageHost.tsx 原样抽出，行为不变）：
 * - ensureMaterials：物料一次性注册（基础 + 图表）
 * - SchemaRenderer：渲染包工厂绑定（react 真实钩子注入——渲染包零运行时 react 红线）
 * - normalizeFields/fieldRefOf/validateLoadedFieldRefs：字段元数据与布局引用纯函数
 * - UnknownWidget：未注册物料占位（L-Node 级不白屏）
 */
import React, { useEffect, useState } from 'react';
import { Alert } from 'antd';
import { registerBasicMaterials, registerChartMaterials } from '@schema/component-materials';
import { materialRegistry, bindSchemaRenderer } from '@schema/schema-renderer';
import { ServerError } from '@schema/schema-form';
import type { FieldSchema, PageSchema } from '@schema/schema-protocol';

// 物料注册（一次性——宿主启动即装载全部基础物料 + 图表物料）
let materialsReady = false;
export function ensureMaterials(): void {
  if (materialsReady) return;
  registerBasicMaterials(materialRegistry);
  registerChartMaterials(materialRegistry);
  materialsReady = true;
}

// SchemaRenderer 工厂绑定（react 真实钩子注入——渲染包零运行时 react 红线）
export const SchemaRenderer = bindSchemaRenderer({ createElement: React.createElement, useState, useEffect });

/** 字段元数据规范化（后端响应 → FieldSchema[]——宽松键位兼容）。 */
export function normalizeFields(raw: unknown): FieldSchema[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { fields?: unknown })?.fields)
      ? (raw as { fields: unknown[] }).fields
      : [];
  return arr.map((f, i) => {
    const o = f as Record<string, unknown>;
    return {
      key: String(o['key'] ?? o['fieldKey'] ?? `f${i}`),
      label: String(o['label'] ?? o['name'] ?? ''),
      type: (o['type'] ?? o['fieldType'] ?? 'text') as FieldSchema['type'],
      fieldStatus: (o['fieldStatus'] ?? (o['deletedAt'] ? 'DELETED' : 'ACTIVE')) as FieldSchema['fieldStatus'],
      required: !!o['required'],
      uniqueFlag: !!o['uniqueFlag'],
      defaultValue: o['defaultValue'] as FieldSchema['defaultValue'],
      enumOptions: o['enumOptions'] as FieldSchema['enumOptions'],
      sortOrder: typeof o['sortOrder'] === 'number' ? o['sortOrder'] : i,
    };
  });
}

/** 模型字段装载后对布局树全量引用核对（语义校验——未知引用拒绝渲染）。 */
export function validateLoadedFieldRefs(page: PageSchema, fields: FieldSchema[]): void {
  const known = new Set(fields.map(field => field.key));
  const visit = (nodes: PageSchema['layout']): void => {
    for (const node of nodes) {
      if (node.fieldRef !== undefined && !known.has(node.fieldRef)) {
        throw new ServerError('PAGE_INVALID', `节点 ${node.id} 引用了模型中不存在的字段 ${node.fieldRef}`);
      }
      if (node.children) visit(node.children);
    }
  };
  visit(page.layout);
}

/** 节点 fieldRef 提取（受控注入定位）。 */
export function fieldRefOf(page: PageSchema, nodeId: string): string | undefined {
  const walk = (nodes: PageSchema['layout']): string | undefined => {
    for (const n of nodes) {
      if (n.id === nodeId) return n.fieldRef;
      if (n.children) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(page.layout);
}

/** 未注册物料占位（L-Node 级不白屏）。 */
export function UnknownWidget(props: Record<string, unknown>): React.ReactElement {
  return <Alert type="warning" showIcon message={`未知物料: ${String(props['name'] ?? '')}`} />;
}
