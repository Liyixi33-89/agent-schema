/**
 * FormPageHost 纯逻辑回归（M11 收口）：
 * validateLoadedFieldRefs 语义校验——模型字段装载后对布局树全量引用核对。
 * （组件级 DOM 回归走浏览器 CDP 验收链路，宿主包不引入 jsdom——零新增依赖红线。）
 */
import { describe, expect, it } from 'vitest';
import type { FieldSchema, PageSchema } from '@schema/schema-protocol';
import { validateLoadedFieldRefs } from './FormPageHost';

const fields: FieldSchema[] = [
  { key: 'title', label: '事由', type: 'text', fieldStatus: 'ACTIVE', sortOrder: 0 },
  { key: 'amount', label: '金额', type: 'number', fieldStatus: 'ACTIVE', sortOrder: 1 },
];

const page = (fieldRef?: string): PageSchema => ({
  id: 'p1', pageKey: 'form', name: '报销登记', type: 'FORM', modelId: '1',
  path: '/form', schemaVersion: 1,
  layout: [{
    id: 'w1', componentName: 'FormItem', props: { label: '事由' },
    children: [{ id: 'n1', componentName: 'TextInput', props: {}, ...(fieldRef ? { fieldRef } : {}) }],
  }],
  actions: [],
});

describe('validateLoadedFieldRefs（模型字段装载后语义校验）', () => {
  it('合法嵌套引用不要求页面内嵌 fields', () => {
    expect(() => validateLoadedFieldRefs(page('title'), fields)).not.toThrow();
  });
  it('未知嵌套字段必须报出节点及字段名', () => {
    expect(() => validateLoadedFieldRefs(page('ghost'), fields))
      .toThrow('节点 n1 引用了模型中不存在的字段 ghost');
  });
  it('模型返回空字段集合时引用不放行', () => {
    expect(() => validateLoadedFieldRefs(page('title'), [])).toThrow('title');
  });
  it('无字段引用的布局不受空字段集合影响', () => {
    expect(() => validateLoadedFieldRefs(page(), [])).not.toThrow();
  });
  it('深层嵌套引用同样被核对', () => {
    const deep: PageSchema = {
      ...page('title'),
      layout: [{
        id: 'l1', componentName: 'Card', props: {},
        children: [{
          id: 'l2', componentName: 'Card', props: {},
          children: [{
            id: 'w9', componentName: 'FormItem', props: {},
            children: [{ id: 'n9', componentName: 'TextInput', props: {}, fieldRef: 'missing' }],
          }],
        }],
      }],
    };
    expect(() => validateLoadedFieldRefs(deep, fields))
      .toThrow('节点 n9 引用了模型中不存在的字段 missing');
  });
});
