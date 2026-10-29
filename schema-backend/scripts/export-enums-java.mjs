/**
 * 后端枚举提取脚本（M1.5 枚举专项 diff 的 Java 侧输入）：
 * 从 schema-protocol 的 Java 枚举类提取与前端 contract/export/enums.json 同结构的
 * contract/export/enums-java.json，CI diff 两份生成物——漂移即 FAIL。
 * 运行：mvn -pl schema-platform/schema-protocol exec:java 或 node 版直跑（无依赖解析时手工镜像清单见注）
 *
 * 注：本脚本用 ripgrep 式扫描源码常量，避免在 M1.4 镜像模块成形前引入完整编译依赖；
 *     M1.4 落地后由 Java 测试直接断言（后端 JUnit 用例读取双份 JSON 对比）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '../../../schema-platform');
const frontEnumsPath = resolve(here, '../../../schema-frontend/packages/schema-protocol/contract/export/enums.json');
const outDir = resolve(here, '../export');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'enums-java.json');

/** Java 枚举类源文件 → 常量列表（按声明顺序）；文件不存在或为空 → 明确报错而非静默空集 */
function extractJavaEnumValues(relPath: string, typeName: string): string[] {
  const abs = join(backendRoot, relPath);
  if (!existsSync(abs)) {
    throw new Error(`Java 枚举源文件不存在: ${abs}（M1.4 镜像模块未落地或路径漂移）`);
  }
  const src = readFileSync(abs, 'utf8');
  const body = src.slice(Math.max(src.lastIndexOf('public enum'), src.lastIndexOf('enum ')));
  const values: string[] = [];
  const re = /^\s{2,}([A-Z][A-Z0-9_]*)(\s*\(|\s*,\s*$|\s*;)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) values.push(m[1]);
  if (values.length === 0) throw new Error(`${typeName}: 未能从 ${relPath} 提取到枚举值`);
  return values;
}

const enumsJava = {
  FieldType: extractJavaEnumValues('schema-protocol/src/main/java/com/schema/protocol/enums/FieldType.java', 'FieldType'),
  FilterOp: extractJavaEnumValues('schema-protocol/src/main/java/com/schema/protocol/enums/FilterOp.java', 'FilterOp'),
  ActionType: extractJavaEnumValues('schema-protocol/src/main/java/com/schema/protocol/enums/ActionType.java', 'ActionType'),
};

writeFileSync(outFile, `${JSON.stringify(enumsJava, null, 2)}\n`, 'utf8');

// 即时 diff：前端真源 vs 后端提取物，不一致直接非零退出（CI 消费同一逻辑）
const front = JSON.parse(readFileSync(frontEnumsPath, 'utf8'));
const failures: string[] = [];
for (const [name, frontValues] of Object.entries(front)) {
  if (!(name in enumsJava)) continue; // 后端暂只镜像协议核心三组，其余组随 M1.4 扩展
  const fv = JSON.stringify(frontValues);
  const bv = JSON.stringify(enumsJava[name]);
  if (fv !== bv) failures.push(`${name}: TS=${fv} Java=${bv}`);
}
if (failures.length > 0) {
  console.error('[export-enums-java] ENUM DIFF FAILED:\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`[export-enums-java] wrote ${Object.keys(enumsJava).length} groups -> ${outFile}; core diff PASS`);
