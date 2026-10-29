package com.schema.page.domain.scan;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 字段引用扫描器（04BE §1.4）：PageSchema 五位置结构化扫描——只做结构提取，不做语义分析。
 *
 * 位置与登记类型（01BE §A.4 幂等键 (model_id, field_key, ref_type, ref_id)）：
 *  1. LayoutNode.fieldRef                        → PAGE
 *  2. ExpressionBinding.dependsOn[]（props 内递归）→ PAGE
 *  3. DataSourceBinding.filter 叶子 field         → PAGE
 *  4. DataSourceBinding.aggregate 的 fieldKey（含 __count 伪字段跳过）→ PAGE
 *  5. scripts[] 内容静态扫描 ctx.form.get('x')/set('x',…) 字面量 → SCRIPT
 *     模板字符串/变量传参不做静态推断（运行期报错兜底）。
 */
public final class FieldRefScanner {

    private FieldRefScanner() {
    }

    /** ctx.form.get('x') / ctx.form.set('x', ...) 单引号/双引号字面量参数。 */
    private static final Pattern SCRIPT_FIELD = Pattern.compile(
            "ctx\\.form\\.(?:get|set)\\(\\s*['\"]([A-Za-z_][\\w]*)['\"]");

    /** 扫描结果：PAGE 引用与 SCRIPT 引用分离（登记类型不同）。 */
    public record ScanResult(Set<String> pageRefs, Set<String> scriptRefs) {
        public static ScanResult empty() {
            return new ScanResult(Set.of(), Set.of());
        }
    }

    @SuppressWarnings("unchecked")
    public static ScanResult scan(Map<String, Object> schema) {
        Set<String> pageRefs = new LinkedHashSet<>();
        Set<String> scriptRefs = new LinkedHashSet<>();
        if (schema == null) {
            return new ScanResult(pageRefs, scriptRefs);
        }

        // 位置 1/2：layout 树（fieldRef + props 内递归表达式依赖）
        if (schema.get("layout") instanceof List<?> layout) {
            for (Object node : layout) {
                if (node instanceof Map<?, ?> m) {
                    scanNode((Map<String, Object>) m, pageRefs);
                }
            }
        }

        // 位置 3/4：dataSource.filter 叶子 / dataSource.aggregate fieldKey
        if (schema.get("dataSource") instanceof Map<?, ?> ds) {
            if (ds.get("filter") != null) {
                scanFilter(ds.get("filter"), pageRefs);
            }
            if (ds.get("aggregate") instanceof Map<?, ?> agg) {
                scanAggregate((Map<String, Object>) agg, pageRefs);
            }
            // sort 字段同样构成引用面（读取列）：补充登记（04BE §1.4 未列但属同构位置；
            // 影响面口径宁全勿漏——排序字段被删时页面同样报错）
            if (ds.get("sort") instanceof List<?> sorts) {
                for (Object s : sorts) {
                    if (s instanceof Map<?, ?> sm && sm.get("field") instanceof String f && !f.isBlank()) {
                        pageRefs.add(f);
                    }
                }
            }
        }

        // 位置 5：scripts[] 静态扫描
        if (schema.get("scripts") instanceof List<?> scripts) {
            for (Object s : scripts) {
                String content = null;
                if (s instanceof Map<?, ?> sm && sm.get("content") instanceof String c) {
                    content = c;
                } else if (s instanceof String str) {
                    content = str;
                }
                if (content != null) {
                    Matcher matcher = SCRIPT_FIELD.matcher(content);
                    while (matcher.find()) {
                        scriptRefs.add(matcher.group(1));
                    }
                }
            }
        }
        // scripts 亦可为 props 内 CUSTOM_SCRIPT 引用之外的独立顶层键；PageSchema 协议 v1
        // 未顶层定义 scripts——L2 钩子脚本挂在节点 props（08FE）。此处兼容两种形态。

        return new ScanResult(pageRefs, scriptRefs);
    }

    private static void scanNode(Map<String, Object> node, Set<String> pageRefs) {
        if (node.get("fieldRef") instanceof String fieldRef && !fieldRef.isBlank()) {
            pageRefs.add(fieldRef);
        }
        if (node.get("props") instanceof Map<?, ?> props) {
            scanProps((Map<String, Object>) props, pageRefs);
        }
        if (node.get("children") instanceof List<?> children) {
            for (Object child : children) {
                if (child instanceof Map<?, ?> m) {
                    scanNode((Map<String, Object>) m, pageRefs);
                }
            }
        }
    }

    /** props 递归：表达式绑定 dependsOn + ActionBinding.paramsMapping/queryMapping 内嵌表达式。 */
    @SuppressWarnings("unchecked")
    private static void scanProps(Map<String, Object> props, Set<String> pageRefs) {
        scanValue(props, pageRefs);
    }

    @SuppressWarnings("unchecked")
    private static void scanValue(Object value, Set<String> pageRefs) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> m = (Map<String, Object>) map;
            // ExpressionBinding：{kind:'expr', source, dependsOn[]}
            if ("expr".equals(m.get("kind")) && m.get("dependsOn") instanceof List<?> deps) {
                for (Object d : deps) {
                    if (d instanceof String s && !s.isBlank()) {
                        pageRefs.add(s);
                    }
                }
            }
            for (Object v : m.values()) {
                if (v instanceof Map || v instanceof List) {
                    scanValue(v, pageRefs);
                }
            }
        } else if (value instanceof List<?> list) {
            for (Object v : list) {
                if (v instanceof Map || v instanceof List) {
                    scanValue(v, pageRefs);
                }
            }
        }
    }

    /** FilterNode 树叶子（{field, op, value} / {and[] / or[]}）。 */
    @SuppressWarnings("unchecked")
    private static void scanFilter(Object filter, Set<String> pageRefs) {
        if (filter instanceof Map<?, ?> m) {
            Map<String, Object> node = (Map<String, Object>) m;
            if (node.get("field") instanceof String field && !field.isBlank()) {
                pageRefs.add(field);
            }
            if (node.get("and") instanceof List<?> ands) {
                for (Object c : ands) {
                    scanFilter(c, pageRefs);
                }
            }
            if (node.get("or") instanceof List<?> ors) {
                for (Object c : ors) {
                    scanFilter(c, pageRefs);
                }
            }
        }
    }

    /** aggregate：measures[].fieldKey + group.fieldKey + timeBucket.fieldKey（__count 伪字段跳过）。 */
    private static void scanAggregate(Map<String, Object> agg, Set<String> pageRefs) {
        if (agg.get("measures") instanceof List<?> measures) {
            for (Object m : measures) {
                if (m instanceof Map<?, ?> mm && mm.get("fieldKey") instanceof String f && !isPseudo(f)) {
                    pageRefs.add(f);
                }
            }
        }
        if (agg.get("group") instanceof Map<?, ?> g && g.get("fieldKey") instanceof String f && !isPseudo(f)) {
            pageRefs.add(f);
        }
        if (agg.get("timeBucket") instanceof Map<?, ?> t && t.get("fieldKey") instanceof String f && !isPseudo(f)) {
            pageRefs.add(f);
        }
    }

    private static boolean isPseudo(String fieldKey) {
        return fieldKey.isBlank() || "__count".equals(fieldKey);
    }
}
