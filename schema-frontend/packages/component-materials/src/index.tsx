/**
 * 基础物料 15 个（05FE §5 薄封装原则）：
 * 每个 = MaterialMeta + 受控组件（value/onChange 契约——03FE §6，禁止内部自持状态）。
 * 薄封装纪律：只做「协议 props → AntD props」翻译与默认值收敛，不含业务逻辑。
 *
 * 运行时依赖说明：antd/react 为 peerDependencies——本包仅声明，
 * 由宿主（designer/runtime）提供实现（与 renderer 的零运行时 react 纪律一致）。
 */
import React from 'react';
import {
  Input, InputNumber, Select, DatePicker, Switch, Upload, Button, Table, Form,
  Card, Tabs, Collapse, Tooltip, Typography,
} from 'antd';
import type { MaterialMeta } from '@schema/schema-renderer';

export interface WidgetProps {
  value?: unknown;
  onChange?: (value: unknown) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  options?: { value: string; label: string }[];
  [key: string]: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** 受控组件映射表：componentName → AntD 薄封装。 */
const widgets: Record<string, React.ComponentType<WidgetProps>> = {
  TextInput: (p) => (
    <Input value={str(p.value) ?? ''} onChange={(e) => p.onChange?.(e.target.value)}
      placeholder={p.placeholder} disabled={bool(p.disabled)} />
  ),
  NumberInput: (p) => (
    <InputNumber value={typeof p.value === 'number' ? p.value : undefined}
      onChange={(v) => p.onChange?.(v)} disabled={bool(p.disabled)} style={{ width: '100%' }} />
  ),
  SelectInput: (p) => (
    <Select value={str(p.value)} onChange={(v) => p.onChange?.(v)}
      options={p.options ?? []} placeholder={p.placeholder} disabled={bool(p.disabled)} allowClear />
  ),
  DateInput: (p) => (
    <DatePicker value={p.value ? (p.value as never) : null} onChange={(_d, ds) => p.onChange?.(ds)}
      disabled={bool(p.disabled)} style={{ width: '100%' }} />
  ),
  BooleanSwitch: (p) => (
    <Switch checked={!!p.value} onChange={(v) => p.onChange?.(v)} disabled={bool(p.disabled)} />
  ),
  FileUpload: (p) => (
    <Upload maxCount={1} onChange={(info) => {
      const file = info.fileList.at(-1);
      p.onChange?.(file ? { fileId: file.uid, name: file.name, size: file.size ?? 0 } : null);
    }}>
      <Button disabled={bool(p.disabled)}>上传附件</Button>
    </Upload>
  ),
  RichtextInput: (p) => (
    <Input.TextArea value={str(p.value) ?? ''} onChange={(e) => p.onChange?.(e.target.value)}
      rows={4} disabled={bool(p.disabled)} />
  ),
  FormItem: (p) => (
    <Form.Item label={p.label} required={!!p.required}>
      {p.children as React.ReactNode}
    </Form.Item>
  ),
  PrimaryButton: (p) => (
    <Button type="primary" onClick={p.onClick as never} disabled={bool(p.disabled)}>
      {p.children as React.ReactNode ?? p.label}
    </Button>
  ),
  DataTable: (p) => (
    <Table size="small" pagination={{ pageSize: 20 }}
      columns={(p.columns as never) ?? []} dataSource={(p.dataSource as never) ?? (p.value as never) ?? []} />
  ),
  SectionCard: (p) => (
    <Card title={p.label} bordered={!bool(p.flat)}>
      {p.children as React.ReactNode}
    </Card>
  ),
  StepsWizard: (p) => (
    <Tabs items={(p.steps as never) ?? []} activeKey={str(p.current) ?? '0'} />
  ),
  GroupCollapse: (p) => (
    <Collapse items={[{ key: 'g', label: p.label ?? '分组', children: p.children as React.ReactNode }]} />
  ),
  LabelText: (p) => <Typography.Text>{p.children as React.ReactNode ?? p.label}</Typography.Text>,
  HintTooltip: (p) => (
    <Tooltip title={p.tooltip ?? p.label}>
      {p.children as React.ReactNode ?? <Typography.Text type="secondary">{p.label}</Typography.Text>}
    </Tooltip>
  ),
};

/** MaterialMeta 注册表（15 个——05FE §5 清单；runtime 全 dynamic 轨道 A）。 */
export const BASIC_MATERIALS: MaterialMeta[] = [
  { componentName: 'TextInput', runtime: 'dynamic', group: '输入', icon: 'edit' },
  { componentName: 'NumberInput', runtime: 'dynamic', group: '输入', icon: 'number' },
  { componentName: 'SelectInput', runtime: 'dynamic', group: '输入', icon: 'unordered-list' },
  { componentName: 'DateInput', runtime: 'dynamic', group: '输入', icon: 'calendar' },
  { componentName: 'BooleanSwitch', runtime: 'dynamic', group: '输入', icon: 'switch' },
  { componentName: 'FileUpload', runtime: 'dynamic', group: '输入', icon: 'paper-clip' },
  { componentName: 'RichtextInput', runtime: 'dynamic', group: '输入', icon: 'align-left' },
  { componentName: 'FormItem', runtime: 'dynamic', group: '布局', icon: 'appstore' },
  { componentName: 'PrimaryButton', runtime: 'dynamic', group: '动作', icon: 'play-circle' },
  { componentName: 'DataTable', runtime: 'dynamic', group: '数据', icon: 'table' },
  { componentName: 'SectionCard', runtime: 'dynamic', group: '布局', icon: 'block' },
  { componentName: 'StepsWizard', runtime: 'dynamic', group: '布局', icon: 'insert' },
  { componentName: 'GroupCollapse', runtime: 'dynamic', group: '布局', icon: 'folder' },
  { componentName: 'LabelText', runtime: 'dynamic', group: '展示', icon: 'font-size' },
  { componentName: 'HintTooltip', runtime: 'dynamic', group: '展示', icon: 'info-circle' },
].map((m) => ({ ...m, component: widgets[m.componentName] }));

/** 字段类型 → 默认 widget 推断表（03FE §2——可被 LayoutNode.props 覆盖）。 */
export function defaultWidgetFor(fieldType: string): string {
  switch (fieldType) {
    case 'text': return 'TextInput';
    case 'number': return 'NumberInput';
    case 'enum': return 'SelectInput';
    case 'date': return 'DateInput';
    case 'boolean': return 'BooleanSwitch';
    case 'file': return 'FileUpload';
    case 'richtext': return 'RichtextInput';
    case 'relation': case 'user': return 'SelectInput';
    case 'dept': return 'SelectInput';
    case 'computed': return 'LabelText';
    default: return 'TextInput';
  }
}

/** 一次性注册全部基础物料（宿主启动时调用）。 */
export function registerBasicMaterials(target: import('@schema/schema-renderer').MaterialRegistry): void {
  for (const m of BASIC_MATERIALS) target.register(m);
}
