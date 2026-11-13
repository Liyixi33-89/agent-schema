/**
 * hostProps 宿主能力注入单测（M16 附件 uploader 闭环的渲染层契约）：
 * NodeView 必须把 hostProps 合并到物料 props 之后——宿主注入的能力位
 * （uploader/downloader）不可被 schema props 覆盖，且逐节点透传到子树。
 *
 * 组件树断言形态：宿主包不引入 jsdom（零新增依赖红线）——用注入的
 * createElement 捕获调用序列，验证最终传给物料的 props 合并结果。
 */
import { describe, expect, it, vi } from 'vitest';
import type { PageSchema, FieldSchema, LayoutNode } from '@schema/schema-protocol';
import { RenderScope, materialRegistry } from '../src/index';
import { bindSchemaRenderer, type ReactPrimitives } from '../src/bindings';

const field = (key: string): FieldSchema => ({
  key, label: key, type: 'file', fieldStatus: 'ACTIVE', sortOrder: 1,
});

const node = (id: string, componentName: string, props: Record<string, unknown> = {}, children?: LayoutNode[]): LayoutNode => ({
  id, componentName, props, ...(children ? { children } : {}),
});

const page = (layout: LayoutNode[]): PageSchema => ({
  id: 'p1', pageKey: 'p1', name: '附件页', type: 'FORM', path: '/test',
  layout, actions: [], schemaVersion: 1,
});

/** 测试物料注册（renderLayout 分派依赖 registry——桩组件登记进全局单例）。 */
function registerTestMaterials(): void {
  materialRegistry.register({ componentName: 'FileUpload', runtime: 'dynamic' });
  materialRegistry.register({ componentName: 'TextInput', runtime: 'dynamic' });
  materialRegistry.register({ componentName: 'Card', runtime: 'dynamic' });
}

describe('hostProps 宿主能力注入（05FE §5 能力位合并）', () => {
  it('hostProps 合并在节点 props 之后且逐节点透传（含子树）', () => {
    registerTestMaterials();
    const scope = new RenderScope();
    const uploads: Array<Record<string, unknown>> = [];
    const cards: Array<Record<string, unknown>> = [];
    // resolver：物料名 → 桩组件（捕获最终 props——renderLayout 已注册所以命中真名）
    const FileUpload = (props: Record<string, unknown>): null => {
      uploads.push(props);
      return null;
    };
    const Card = (props: Record<string, unknown>): null => {
      cards.push(props);
      return null;
    };
    const resolver = (name: string) =>
      name === 'FileUpload' ? FileUpload : name === 'Card' ? Card : undefined;

    const react: ReactPrimitives = {
      // createElement 桩（宿主语义）：函数组件立即执行捕获 props；宿主元素返回 null
      createElement: ((type: unknown, props: unknown) =>
        typeof type === 'function' ? (type as (p: unknown) => unknown)(props) : null) as never,
      useState: (init: unknown) => [init, () => {}],
      useEffect: () => {},
    };
    const SchemaRenderer = bindSchemaRenderer(react);

    const uploader = vi.fn();
    const downloader = vi.fn();
    SchemaRenderer({
      page: page([
        node('c1', 'Card', { label: '分组' }, [
          node('f1', 'FileUpload', { placeholder: '选择文件' }),
        ]),
      ]),
      scope,
      fields: new Map([['attach', field('attach')]]),
      resolveComponent: resolver as never,
      react,
      hostProps: { uploader, downloader },
    });

    // 桩 createElement 对宿主 div 返回 null（组件函数已执行——以捕获为准）
    expect(uploads).toHaveLength(1);
    // 宿主能力位注入（合并后存在且引用一致）
    expect(uploads[0]['uploader']).toBe(uploader);
    expect(uploads[0]['downloader']).toBe(downloader);
    // 节点自身 props 保留
    expect(uploads[0]['placeholder']).toBe('选择文件');
    expect(uploads[0]['data-node-id']).toBe('f1');
    // 容器节点同样收到注入（逐节点合并）
    expect(cards[0]['uploader']).toBe(uploader);
  });

  it('不传 hostProps 时行为不变（既有渲染零影响）', () => {
    const scope = new RenderScope();
    const inputs: Array<Record<string, unknown>> = [];
    const TextInput = (props: Record<string, unknown>): null => {
      inputs.push(props);
      return null;
    };
    const react: ReactPrimitives = {
      createElement: ((type: unknown, props: unknown) =>
        typeof type === 'function' ? (type as (p: unknown) => unknown)(props) : null) as never,
      useState: (init: unknown) => [init, () => {}],
      useEffect: () => {},
    };
    const SchemaRenderer = bindSchemaRenderer(react);
    SchemaRenderer({
      page: page([node('n1', 'TextInput', { label: '事由' })]),
      scope,
      fields: new Map(),
      resolveComponent: (() => TextInput) as never,
      react,
    });
    expect(inputs[0]['label']).toBe('事由');
    expect(inputs[0]['uploader']).toBeUndefined();
  });
});
