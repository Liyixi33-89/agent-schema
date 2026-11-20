/**
 * 字段类型相关配置表单与解析（10FE §1——自 FieldEditorDrawer.tsx 原样抽出，行为不变）：
 * - TypeConfigForm：按选中类型受控渲染 enum/relation/computed 配置块
 * - parseFieldConfigs：表单值 → 字段配置纯函数（原内联闭包参数化——编辑/新增同构）
 */
import React from 'react';
import { Form, Input, Select } from 'antd';
import type { ModelSummary } from '../../shared/api';
import {
  RELATION_CARDINALITIES, RELATION_CASCADES, COMPUTED_PERSIST_MODES,
} from '@schema/data-model-designer';
import type { DraftField } from './modelTabShared';

/** 类型相关配置表单（01BE §4.2 步骤 4：enum→enumOptions / relation→目标+基数+级联 / computed→表达式+依赖）。 */
export function TypeConfigForm({ curType, models }: {
  curType: string;
  models: ModelSummary[] | null;
}): React.ReactElement | null {
  if (curType === 'enum') {
    return (
      <Form.Item name="enumOptionsStr" label="枚举选项（每行 value|label，value 不可重复）"
        rules={[{
          validator: (_: unknown, value: string) => {
            if (!value?.trim()) return Promise.resolve();
            const seen = new Set<string>();
            for (const line of value.split('\n')) {
              const parts = line.trim().split('|');
              if (parts.length !== 2 || !parts[0] || !parts[1]) return Promise.reject(new Error('格式：value|label'));
              if (seen.has(parts[0])) return Promise.reject(new Error(`value 重复：${parts[0]}`));
              seen.add(parts[0]);
            }
            return Promise.resolve();
          },
        }]}>
        <Input.TextArea rows={3} placeholder={'draft|草稿\napproved|已审批'} />
      </Form.Item>
    );
  }
  if (curType === 'relation') {
    return (
      <>
        <Form.Item name={['relation', 'targetModelId']} label="关联目标模型"
          rules={[{ required: true, message: '请选择目标模型' }]}>
          <Select options={models?.filter((mm) => mm.status === 'ACTIVE').map((mm) => ({ value: mm.id, label: `${mm.name}（${mm.modelKey}）` })) ?? []} />
        </Form.Item>
        <Form.Item name={['relation', 'cardinality']} label="基数" initialValue="1:n"
          rules={[{ required: true }]}>
          <Select options={RELATION_CARDINALITIES.map((c) => ({
            value: c,
            label: c === '1:1' ? '1:1 一对一' : c === '1:n' ? '1:n 一对多' : 'n:n 多对多',
          }))} />
        </Form.Item>
        <Form.Item name={['relation', 'cascade']} label="级联策略" initialValue="FORBID"
          rules={[{ required: true }]}>
          <Select options={RELATION_CASCADES.map((c) => ({
            value: c,
            label: c === 'FORBID' ? 'FORBID 禁止删除' : c === 'SET_NULL' ? 'SET_NULL 置空' : 'CASCADE_SOFT_DELETE 级联软删',
          }))} />
        </Form.Item>
      </>
    );
  }
  if (curType === 'computed') {
    return (
      <>
        <Form.Item name={['computed', 'expr', 'source']} label="计算表达式（白名单表达式，如 amount * 2）"
          rules={[{ required: true, message: '请输入表达式' }]}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name={['computed', 'dependsOn']} label="依赖字段（逗号分隔）"
          rules={[{ required: true, message: '请填写依赖字段' }]}>
          <Input placeholder="amount, rate" />
        </Form.Item>
        <Form.Item name={['computed', 'persistMode']} label="持久化模式" initialValue="READ_TIME" rules={[{ required: true }]}>
          <Select options={COMPUTED_PERSIST_MODES.map((m) => ({
            value: m,
            label: m === 'READ_TIME' ? 'READ_TIME 读时计算' : 'PERSISTED 写时物化',
          }))} />
        </Form.Item>
      </>
    );
  }
  return null;
}

/** 表单原始值（validateFields 结果——宽松形态）。 */
interface FieldFormValues {
  type?: string;
  enumOptionsStr?: string;
  relation?: { targetModelId?: string; cardinality?: string; cascade?: string };
  computed?: { expr?: { source?: string }; dependsOn?: string; persistMode?: string };
}

/** 表单值 → 字段配置（enum/relation/computed；enumOptionsStr 文本按行解析）。
 *  curType：当前生效类型（新增取受控类型，修改取字段冻结类型——表单 disabled Select 不入 values）。 */
export function parseFieldConfigs(v: FieldFormValues, curType: string | undefined): Pick<DraftField, 'enumOptions' | 'relation' | 'computed'> {
  const out: Pick<DraftField, 'enumOptions' | 'relation' | 'computed'> = {};
  const t = typeof v.type === 'string' ? v.type : curType ?? '';
  if (t === 'enum') {
    const lines = String(v.enumOptionsStr ?? '').split('\n').filter((l) => l.trim());
    if (lines.length) {
      out.enumOptions = lines.map((l) => {
        const [value, label] = l.trim().split('|');
        return { value, label, status: 'ACTIVE' };
      });
    }
  }
  if (t === 'relation') {
    if (v.relation?.targetModelId) {
      const cardinality = (RELATION_CARDINALITIES as readonly string[]).includes(v.relation.cardinality ?? '')
        ? v.relation.cardinality as typeof RELATION_CARDINALITIES[number] : '1:n';
      const cascade = (RELATION_CASCADES as readonly string[]).includes(v.relation.cascade ?? '')
        ? v.relation.cascade as typeof RELATION_CASCADES[number] : 'FORBID';
      out.relation = {
        targetModelId: String(v.relation.targetModelId),
        cardinality,
        cascade,
      };
    }
  }
  if (t === 'computed') {
    if (v.computed?.expr?.source) {
      const persistMode = (COMPUTED_PERSIST_MODES as readonly string[]).includes(v.computed.persistMode ?? '')
        ? v.computed.persistMode as typeof COMPUTED_PERSIST_MODES[number] : 'READ_TIME';
      out.computed = {
        expr: { kind: 'expr', source: String(v.computed.expr.source) },
        dependsOn: String(v.computed.dependsOn ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        persistMode,
      };
    }
  }
  return out;
}
