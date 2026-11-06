/**
 * 设计器物料面板清单 + 15 物料 propsSchema/defaultProps/acceptChildren 真源。
 * componentName 与 component-materials 注册表一一对应（协议物料名，不另起 AntD 名）。
 */
import type { PanelMaterial, PropSchemaGroup } from './panel-schema';

const basic = (extra?: Partial<PanelMaterial>): Omit<PanelMaterial, 'componentName' | 'group' | 'icon'> => ({
  acceptChildren: false,
  defaultProps: {},
  propsSchema: [],
  ...extra,
});

/** 输入类物料通用属性组。 */
const inputProps = (extra: PropSchemaGroup[] = []): PropSchemaGroup[] => [
  { title: '基础属性', fields: [
    { key: 'placeholder', label: '占位符', widget: 'text' },
    { key: 'disabled', label: '禁用', widget: 'switch' },
  ] },
  ...extra,
];

const exprGroup: PropSchemaGroup = { title: '联动规则', fields: [
  { key: 'visibleWhen', label: '显示条件', widget: 'expr', placeholder: "如 {{ status === 'draft' }}" },
  { key: 'disabledWhen', label: '禁用条件', widget: 'expr' },
  { key: 'requiredWhen', label: '必填条件', widget: 'expr' },
] };

const fieldBind: PropSchemaGroup = { title: '数据绑定', fields: [
  { key: 'fieldRef', label: '绑定字段', widget: 'fieldRef' },
] };

/** 容器通用属性组。 */
const containerProps = (labelField = true): PropSchemaGroup[] => [{
  title: '基础属性',
  fields: labelField
    ? [{ key: 'label', label: '标题', widget: 'text' }]
    : [{ key: 'flat', label: '无边框', widget: 'switch' }],
}];

export const PANEL_MATERIALS: PanelMaterial[] = [
  { componentName: 'TextInput', group: '输入', icon: 'edit', ...basic({ propsSchema: inputProps([fieldBind, exprGroup]) }) },
  { componentName: 'NumberInput', group: '输入', icon: 'number', ...basic({ propsSchema: inputProps([fieldBind, exprGroup]) }) },
  { componentName: 'SelectInput', group: '输入', icon: 'unordered-list', ...basic({
    defaultProps: { options: [] },
    propsSchema: [
      { title: '基础属性', fields: [
        { key: 'placeholder', label: '占位符', widget: 'text' },
        { key: 'disabled', label: '禁用', widget: 'switch' },
      ] },
      fieldBind, exprGroup,
    ],
  }) },
  { componentName: 'DateInput', group: '输入', icon: 'calendar', ...basic({ propsSchema: inputProps([fieldBind, exprGroup]) }) },
  { componentName: 'BooleanSwitch', group: '输入', icon: 'switch', ...basic({ propsSchema: [
    { title: '基础属性', fields: [{ key: 'disabled', label: '禁用', widget: 'switch' }] },
    fieldBind, exprGroup,
  ] }) },
  { componentName: 'FileUpload', group: '输入', icon: 'paper-clip', ...basic({ propsSchema: inputProps([fieldBind]) }) },
  { componentName: 'RichtextInput', group: '输入', icon: 'align-left', ...basic({ propsSchema: inputProps([fieldBind, exprGroup]) }) },
  { componentName: 'FormItem', group: '布局', icon: 'appstore', ...basic({
    acceptChildren: true,
    defaultProps: { label: '表单项' },
    propsSchema: [{ title: '基础属性', fields: [
      { key: 'label', label: '标签', widget: 'text' },
      { key: 'required', label: '必填', widget: 'switch' },
    ] }],
  }) },
  { componentName: 'PrimaryButton', group: '动作', icon: 'play-circle', ...basic({
    defaultProps: { label: '按钮' },
    propsSchema: [{ title: '基础属性', fields: [
      { key: 'label', label: '按钮文案', widget: 'text' },
      { key: 'disabled', label: '禁用', widget: 'switch' },
    ] }],
  }) },
  { componentName: 'DataTable', group: '数据', icon: 'table', ...basic({ propsSchema: [] }) },
  { componentName: 'SectionCard', group: '布局', icon: 'block', ...basic({
    acceptChildren: true,
    defaultProps: { label: '卡片' },
    propsSchema: containerProps(),
  }) },
  { componentName: 'StepsWizard', group: '布局', icon: 'insert', ...basic({
    acceptChildren: true,
    defaultProps: { stepLabels: [] },
    propsSchema: [{ title: '基础属性', fields: [
      { key: 'label', label: '标题', widget: 'text' },
    ] }],
  }) },
  { componentName: 'GroupCollapse', group: '布局', icon: 'folder', ...basic({
    acceptChildren: true,
    defaultProps: { label: '分组' },
    propsSchema: containerProps(),
  }) },
  { componentName: 'LabelText', group: '展示', icon: 'font-size', ...basic({
    defaultProps: { label: '文本' },
    propsSchema: [{ title: '基础属性', fields: [{ key: 'label', label: '文本内容', widget: 'text' }] }],
  }) },
  { componentName: 'HintTooltip', group: '展示', icon: 'info-circle', ...basic({
    defaultProps: { label: '提示' },
    propsSchema: [{ title: '基础属性', fields: [
      { key: 'label', label: '提示内容', widget: 'text' },
      { key: 'tooltip', label: '悬浮提示', widget: 'text' },
    ] }],
  }) },
];

const byName = new Map(PANEL_MATERIALS.map((m) => [m.componentName, m]));

export function panelMaterial(componentName: string): PanelMaterial | undefined {
  return byName.get(componentName);
}

/** 落点校验注入（DesignerStore.validateDropTarget 的 acceptsChildren 真源）。 */
export function acceptsChildren(componentName: string): boolean {
  return byName.get(componentName)?.acceptChildren ?? false;
}

/** 面板分组视图清单。 */
export interface PanelGroup { title: string; materials: PanelMaterial[] }

export function panelGroups(): PanelGroup[] {
  const groups: PanelGroup[] = [];
  for (const m of PANEL_MATERIALS) {
    let g = groups.find((x) => x.title === m.group);
    if (!g) { g = { title: m.group, materials: [] }; groups.push(g); }
    g.materials.push(m);
  }
  return groups;
}
