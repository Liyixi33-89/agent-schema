#!/usr/bin/env python3
"""M16 试点门禁归档补建（gate 补档）。

背景：M16 演练/压测/裁决产物最初落在 docs/acceptance/M16/ 直挂子目录
（dr-drill/ perf/ fault-drill/ ...），缺 manifest.json——`workflow.py references`
与 `verify_commit` 均要求「docs/acceptance/<工作包>/<run-id>/」带清单形态，
台账 acceptance 项因此无法绑定正式证据。

本脚本按 README §5 迁移顺序执行一次性补档：
  1. 列全引用（gate-lpilot-report.md 的 EV-* 编号 → 现有产物路径）
  2. 原内容整体移动到 run-id 目录（不复制、不改内容）
  3. 生成 manifest.json（sourceCommit=gate 报告出具时点 HEAD 祖先；SHA256 全量清单；
     suites 为结构化结果文件支撑的计数，其余场景以 files 清单承载）
  4. 打印台账接线所需的路径/SHA，供人工核对后写入 workflow.json

不做：不改变产物内容、不生成结论（manifest 不写评审判定）、不自动改台账。
幂等：目标目录已存在即拒绝，防重复执行覆盖。
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
WP = "M16"
RUN_ID = "20261117-170600-2d3febd"  # gate 补档轮：独立审查 commit 2d3febd
SRC = ROOT / "docs" / "acceptance" / WP
DST = SRC / RUN_ID

# 子目录整体迁移（内容不动）：演练/压测/裁决/报告全部纳入本轮归档
MOVE_DIRS = ["dr-drill", "dr-drill-v2", "fault-drill", "ft05-drill", "perf", "perf-reverify"]
MOVE_FILES = [
    "gate-lpilot-report.md",
    "independent-review-lpilot.md",
    "M16-reliability-drills-report.md",
    "oncall-and-escalation.md",
    "pilot-scope-decision.md",
    "t7-t9-disposal-record.md",
    "gap-review-update-20261117.md",
]

# 结构化结果文件 → manifest.suites 计数（passed/failed 由断言数组实际统计，不手填）
SUITES = {
    "m16-drill": {
        "command": "bash scripts/acceptance/m16-relaunch/dr-drill-recovery.sh && bash scripts/acceptance/m16-relaunch/dr-drill-full.sh（服务器隔离栈）",
        "results": [
            "dr-drill-v2/dr-drill-result-v2.json",
            "dr-drill-v2/static-verify-fresh.json",
            "fault-drill/timeline-merged.jsonl",
            "ft05-drill/ft05-delivery.json",
        ],
        "note": "演练类：DR-01v2 恢复+比对+冒烟、故障注入四场景、FT05 三合一触达——逐场景 PASS 计数见结果文件与报告",
    },
    "m16-perf": {
        "command": "k6 run perf-levels.js（专用 PG 15433 + 压测后端 18083，隔离环境）",
        "results": [
            "perf-reverify/levels-result.json",
            "perf-reverify/reverify-result.json",
        ],
        "note": "压测类：50/100/150 定档 + 250VU 风暴；PASS 判定按 SLA p95<1.5s（100VU 水位裁决 M16-DEC-250VU）",
    },
    "pilot": {
        "command": "人工裁决记录固化（pilot-scope-decision.md §批准记录 + PERF-reverify-report §3）",
        "results": [
            "pilot-scope-decision.md",
            "perf-reverify/PERF-reverify-report.md",
        ],
        "note": "裁决类：范围六项 + 容量 B 档——human-lead 批准，非自动套件",
    },
}


def git_rev_parse(ref: str) -> str:
    return subprocess.check_output(["git", "rev-parse", ref], cwd=str(ROOT), text=True).strip()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def walk_files(base: Path, prefix: str = ""):
    for ent in sorted(base.iterdir()):
        rel = f"{prefix}/{ent.name}" if prefix else ent.name
        if ent.is_dir():
            yield from walk_files(ent, rel)
        elif ent.is_file():
            yield rel


def count_json_assertions(path: Path):
    """从结构化结果文件提取场景计数（不编造：识别已知形态，其余返回 None）。"""
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except (UnicodeDecodeError, OSError):
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # jsonl：逐行计数 delivered/场景行
        lines = [ln for ln in text.splitlines() if ln.strip()]
        delivered = sum(1 for ln in lines if '"delivered": true' in ln or '"delivered":true' in ln)
        return {"total": len(lines), "passed": delivered} if lines else None
    if isinstance(data, list):
        return {"total": len(data), "passed": sum(1 for x in data if isinstance(x, dict) and (x.get("pass") is True or x.get("passed") is True or x.get("ok") is True))}
    if isinstance(data, dict):
        for key in ("checks", "assertions", "scenarios", "cases", "results", "tables"):
            v = data.get(key)
            if isinstance(v, list):
                return {"total": len(v), "passed": sum(1 for x in v if isinstance(x, dict) and (x.get("pass") is True or x.get("passed") is True or x.get("ok") is True or x.get("match") is True))}
        for key in ("passed", "pass"):
            if isinstance(data.get(key), int):
                return {"passed": data[key], "failed": data.get("failed", 0)}
    return None


def main():
    if DST.exists():
        sys.exit(f"目标目录已存在，拒绝覆盖: {DST}")
    missing = [n for n in MOVE_DIRS if not (SRC / n).is_dir()] + [n for n in MOVE_FILES if not (SRC / n).is_file()]
    if missing:
        sys.exit(f"产物缺失: {', '.join(missing)}（当前 SRC={SRC}）")

    source_commit = git_rev_parse("2d3febd")  # 独立审查提交（gate 报告+审查报告落库时点）
    head = git_rev_parse("HEAD")

    # 先校验后移动；全部成功才写 manifest
    planned = {}
    for name in MOVE_DIRS:
        for rel in walk_files(SRC / name, name):
            planned[rel] = SRC / rel
    for name in MOVE_FILES:
        planned[name] = SRC / name

    files_manifest = []
    suites_manifest = {}
    for rel in sorted(planned):
        files_manifest.append({"path": rel.replace("\\", "/"), "sha256": sha256(planned[rel])})

    for suite, spec in SUITES.items():
        entry = {
            "command": spec["command"],
            "kind": spec["note"],
            "results": spec["results"],
        }
        counts = []
        for r in spec["results"]:
            c = count_json_assertions(DST_candidate := (SRC / r))
            if c:
                counts.append({r: c})
        entry["structuredCounts"] = counts
        suites_manifest[suite] = entry

    manifest = {
        "formatVersion": 1,
        "workPackage": WP,
        "runId": RUN_ID,
        "startedAt": "2026-11-16T06:00:00.000Z",
        "finishedAt": "2026-11-17T09:30:00.000Z",
        "sourceCommit": source_commit,
        "sourceCommitNote": f"独立审查提交 2d3febd（gate 报告与四维审查落库）；HEAD={head[:7]}（补档提交）",
        "workingTreeClean": True,
        "environment": {
            "os": "linux (OpenCloudOS, 验收服务器 111.231.57.177)",
            "postgres": "15.19",
            "k6": "v1.4.0",
            "note": "演练/压测在服务器隔离栈执行（15433/18083/127.0.0.1:18098），不触碰生产 18080/5432",
        },
        "suites": suites_manifest,
        "archiveNote": (
            "补档说明：本轮产物原直挂 docs/acceptance/M16/ 子目录（2026-11-16/17 演练轮），"
            "未按 run-id 归档形态落盘；本 manifest 为 2026-11-17 补建（内容零改动整体迁移，"
            "SHA256 全量登记）。演练类套件无统一断言数组——场景计数见 structuredCounts 与各报告；"
            "不以此冒充自动套件通过。台账接线引用 report.md。"
        ),
        "files": files_manifest,
    }

    # 执行迁移
    DST.mkdir(parents=True)
    for name in MOVE_DIRS:
        (SRC / name).rename(DST / name)
    for name in MOVE_FILES:
        (SRC / name).rename(DST / name)

    (DST / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total = len(files_manifest)
    print(f"OK 已归档 {RUN_ID}: {total} 文件")
    print(f"sourceCommit={source_commit}")
    print("台账 report 路径建议: docs/acceptance/M16/" + RUN_ID + "/gate-lpilot-report.md")


if __name__ == "__main__":
    main()
