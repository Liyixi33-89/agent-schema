/**
 * 表单宿主共享层（渐进重构第三阶段——normalizeFields/UnknownWidget/showError 归集至
 * @schema/shared-ui；此处保持原路径 re-export，调用面零改动）：
 * - ensureMaterials：物料一次性注册（基础 + 图表）
 * - SchemaRenderer：渲染包工厂绑定（react 真实钩子注入——渲染包零运行时 react 红线）
 * - validateLoadedFieldRefs/fieldRefOf：布局引用纯函数
 */
import React, { useEffect, useState } from 'react';
import { registerBasicMaterials, registerChartMaterials } from '@schema/component-materials';
import { materialRegistry, bindSchemaRenderer } from '@schema/schema-renderer';
import { ServerError } from '@schema/schema-form';
import type { FieldSchema, PageSchema } from '@schema/schema-protocol';
import {
  normalizeFields, UnknownWidget, showError,
} from '@schema/shared-ui';

export { normalizeFields, UnknownWidget, showError };

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
