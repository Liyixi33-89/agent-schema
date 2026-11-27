"""test_gate 必跑清单一致性检查（2026-11-27 补，防「清单漂移」）。

## 为什么需要
门禁清单是**手写常量**，而 E2E 场景随功能增长。两者一旦不同步：
- 新增场景没登记 → 删掉/误配该测试文件，门禁照样绿（假的通过）
- 登记了不存在的场景 → 门禁永远「必跑场景缺失」，CI 假红

2026-11-27 评审指出：CI 实际跑 11 条，清单只有 3 条。
本脚本把「清单 == 仓库真实存在的 SMK 场景」变成可执行断言。

## 用法（不依赖 pytest，任意环境可跑）
    python scripts/check_test_gate_manifest.py
退出码 0 = 一致；1 = 有漂移（输出具体项）。

## 接入
- `scripts/verify.ps1` 的 frontend-test 步骤之后调用
- 也可单独作为 CI 检查
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.test_gate import REQUIRED_SMOKE  # noqa: E402

E2E_DIR = ROOT / 'schema-frontend' / 'e2e'
CONFIG = ROOT / 'schema-frontend' / 'playwright.config.ts'

# SMK 场景声明行：test('SMK-XXX-NN ...') 或 test.describe
SCENARIO_RE = re.compile(r"""test(?:\.describe)?\(\s*['"](SMK-[A-Z]+-\d+)""")


def scan_scenarios():
    """扫描 e2e/ 下所有 SMK 场景 → {scenario: file_name}。"""
    found = {}
    if not E2E_DIR.is_dir():
        return found
    for spec in sorted(E2E_DIR.glob('*.spec.ts')):
        for line in spec.read_text(encoding='utf-8').splitlines():
            for m in SCENARIO_RE.finditer(line):
                found[m.group(1)] = spec.name
    return found


def scan_projects():
    """从 playwright.config.ts 提取 [(project名, testMatch正则)]。"""
    text = CONFIG.read_text(encoding='utf-8')
    out = []
    for m in re.finditer(r"name:\s*'([^']+)'[^}]*?testMatch:\s*/([^/]+)/", text, re.S):
        out.append((m.group(1), m.group(2)))
    return out


def main() -> int:
    problems = []

    actual = scan_scenarios()
    if not actual:
        problems.append(f'未从 {E2E_DIR} 扫描到任何 SMK 场景（目录或命名变了？）')

    # ① 清单里的场景必须真实存在
    for s in REQUIRED_SMOKE:
        if s not in actual:
            problems.append(f'{s}: 清单登记但 e2e/ 下找不到对应 test()（门禁会永远失败）')

    # ② 反向：真实场景必须都登记（否则删掉它门禁也不会发现）
    for s in actual:
        if s not in REQUIRED_SMOKE:
            problems.append(
                f'{s}（{actual[s]}）: 未登记为必跑——删掉该测试文件门禁仍会通过')

    # ③ 文件名与清单声明一致
    for s, (declared_file, _p) in REQUIRED_SMOKE.items():
        real = actual.get(s)
        if real is not None and real != declared_file:
            problems.append(f'{s}: 清单说在 {declared_file}，实际在 {real}')

    # ④ project 存在 + testMatch 覆盖该文件
    projects = dict(scan_projects())
    if not projects:
        problems.append('未能从 playwright.config.ts 解析出 project（正则失效？）')
    for s, (file_name, project) in REQUIRED_SMOKE.items():
        pattern = projects.get(project)
        if pattern is None:
            problems.append(
                f'{s}: project "{project}" 未在 playwright.config.ts 定义，可用: {sorted(projects)}')
            continue
        stem = file_name.replace('.spec.ts', '')
        try:
            if not re.search(re.escape(stem), pattern) and not re.search(pattern, file_name):
                problems.append(
                    f'{s}: project "{project}" 的 testMatch /{pattern}/ 不覆盖 {file_name}')
        except re.error:
            problems.append(f'{s}: project "{project}" 的 testMatch 正则无效: {pattern}')

    if problems:
        print('[FAIL] 必跑清单与仓库不一致：')
        for p in problems:
            print('  - ' + p)
        return 1

    print(f'[PASS] 必跑清单一致：{len(REQUIRED_SMOKE)} 个场景，'
          f'分布在 {len({v[0] for v in REQUIRED_SMOKE.values()})} 个文件')
    return 0


if __name__ == '__main__':
    sys.exit(main())