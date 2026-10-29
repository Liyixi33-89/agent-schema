/**
 * 枚举导出脚本（M1.5 契约 CI 三件套之一）：
 * 从 TS 常量真源导出 contract/export/enums.json，后端从 Java 枚举类提取同结构文件，
 * CI diff 两份生成物——任何一侧枚举漂移即 FAIL。
 * 运行：node packages/schema-protocol/scripts/export-enums.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 与 src/types.ts 常量数组逐项对应（脚本消费编译期类型约束的运行时值）
const enums = {
  FieldType: ['text', 'number', 'date', 'enum', 'boolean', 'file', 'richtext', 'relation', 'geo', 'user', 'dept', 'computed'],
  FieldStatus: ['ACTIVE', 'DELETED'],
  FilterOp: ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'like', 'between', 'isnull'],
  ActionType: ['SUBMIT', 'TRIGGER_FLOW', 'CALL_API', 'OPEN_PAGE', 'DELETE', 'CUSTOM_SCRIPT'],
  AggregateFunc: ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MAX', 'MIN'],
  TimeBucketInterval: ['DAY', 'WEEK', 'MONTH'],
  PageType: ['FORM', 'LIST', 'DETAIL', 'DASHBOARD'],
  DataSourceType: ['MODEL_LIST', 'MODEL_DETAIL', 'MODEL_AGG', 'STATIC_JSON'],
};

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../contract/export');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'enums.json');
writeFileSync(outFile, `${JSON.stringify(enums, null, 2)}\n`, 'utf8');
console.log(`[export-enums] wrote ${Object.keys(enums).length} enum groups -> ${outFile}`);
