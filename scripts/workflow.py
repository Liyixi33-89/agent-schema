"""Repository-local task workflow; acceptance is evidence-based, never inferred from builds."""
import argparse
import json
import os
import subprocess
import re
from pathlib import Path


def _resolve_root():
    """仓库根：默认脚本上级目录；测试可用 SCHEMA_WORKFLOW_ROOT 指向临时 Git 仓库。"""
    override = os.environ.get('SCHEMA_WORKFLOW_ROOT')
    return Path(override).resolve() if override else Path(__file__).resolve().parents[1]


ROOT = _resolve_root()
LEDGER = ROOT / '.agent' / 'workflow.json'
EVIDENCE_TOOL = Path(__file__).resolve().parents[1] / 'scripts' / 'acceptance' / 'evidence.cjs'
IMPLEMENTATION_PATHS = ('schema-frontend', 'schema-platform', 'scripts', 'contract', 'sql')
STATES = ('planned', 'ready', 'implementing', 'implemented', 'verified', 'accepted', 'blocked')


def git_head():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def run_evidence_check(archive_rel):
    """调用项目归档校验工具；工具缺失/失败都视为校验失败，不静默降级。

    测试注入根须同时声明 SCHEMA_EVIDENCE_ROOT（临时 Git 仓库）；
    ACCEPT_EVIDENCE_* 一律剥离——正式验收不允许改道归档目录。
    """
    if not EVIDENCE_TOOL.is_file():
        return ['evidence tool missing: ' + str(EVIDENCE_TOOL)]
    strip = ('ACCEPT_EVIDENCE_ARCHIVE', 'ACCEPT_EVIDENCE_OUT')
    env = {k: v for k, v in os.environ.items() if k not in strip}
    cwd = Path(os.environ.get('SCHEMA_EVIDENCE_ROOT', ROOT)) if os.environ.get('SCHEMA_EVIDENCE_ROOT') else ROOT
    proc = subprocess.run(['node', str(EVIDENCE_TOOL), 'check', archive_rel], cwd=cwd,
                          capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        lines = [ln for ln in (proc.stdout + proc.stderr).splitlines() if ln.strip()]
        return lines or [f'archive check failed (exit={proc.returncode})']
    return []


def implementation_changed_between(source_commit, head):
    """源码提交与 HEAD 之间实现/测试路径是否有改动——有则证据失效，须重验。"""
    diff = subprocess.run(['git', 'diff', '--name-only', source_commit, head, '--', *IMPLEMENTATION_PATHS],
                          cwd=ROOT, capture_output=True, text=True)
    if diff.returncode != 0:
        raise ValueError('git diff failed: ' + diff.stderr.strip())
    return [ln for ln in diff.stdout.splitlines() if ln.strip()]


def verify_commit(record, label, work_package=None):
    """校验证据提交：允许 manifest.sourceCommit ≠ HEAD（证据提交独立），但实现路径不得变化。"""
    issues = []
    head = git_head()
    commit = record.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        return [f'{label}: invalid full source SHA']
    for args in (['cat-file', '-e', commit + '^{commit}'], ['merge-base', '--is-ancestor', commit, head]):
        proc = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)
        if proc.returncode != 0:
            return [f'{label}: source commit missing or not HEAD ancestor']
    raw_report = Path(record.get('report', ''))
    report = (ROOT / raw_report).resolve()
    evidence_root = (ROOT / 'docs' / 'acceptance').resolve()
    if (raw_report.is_absolute() or '..' in raw_report.parts or 'legacy' in raw_report.parts
            or not report.is_relative_to(evidence_root) or not report.is_file()):
        return [f'{label}: report missing, outside acceptance archive, or legacy']
    manifest = None
    for parent in report.parents:
        candidate = parent / 'manifest.json'
        if candidate.is_file():
            manifest = json.loads(candidate.read_text(encoding='utf-8-sig'))
            break
    if manifest is None:
        issues.append(f'{label}: no manifest.json in report ancestry (docs/acceptance/<wp>/<run-id>/)')
        return issues
    if work_package and manifest.get('workPackage') != work_package:
        issues.append(f'{label}: work package mismatch')
    expected = evidence_root / str(manifest.get('workPackage', '')) / str(manifest.get('runId', ''))
    if candidate.parent.resolve() != expected.resolve():
        issues.append(f'{label}: manifest directory mismatch')
    rel_report = report.relative_to(candidate.parent).as_posix()
    if not any(f.get('path', '').replace('\\', '/') == rel_report for f in manifest.get('files', [])):
        issues.append(f'{label}: report not covered by manifest hashes')
    if label != 'review':
        suite = manifest.get('suites', {}).get(record.get('suite'))
        if not suite or suite.get('command') != record.get('command'):
            issues.append(f'{label}: missing suite or command mismatch')
        elif (suite.get('exitCode') != 0 or suite.get('failed') != 0
              or suite.get('skipped') != 0 or not suite.get('passed', 0) > 0):
            issues.append(f'{label}: failed/skipped suite cannot certify acceptance')
    if manifest.get('workingTreeClean') is not True:
        issues.append(f'{label}: source working tree was not clean')
    archive_rel = str(manifest.get('workPackage', '')) + '/' + str(manifest.get('runId', ''))
    issues += run_evidence_check(archive_rel)
    source = manifest.get('sourceCommit')
    if not source or source != commit:
        issues.append(f'{label}: ledger commit != manifest sourceCommit')
    changed = implementation_changed_between(source, head) if source and source != head else []
    if changed:
        issues.append(f'{label}: implementation changed since sourceCommit — re-run acceptance ({len(changed)} files)')
    if commit == head and source != head:
        pass  # 证据提交独立合法；实现未变即可
    return issues


def load():
    data = json.loads(LEDGER.read_text(encoding='utf-8-sig'))
    ids = [t['id'] for t in data['tasks']]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate task IDs')
    for task in data['tasks']:
        if task['status'] not in STATES:
            raise ValueError('Invalid status: ' + task['id'])
        if any(d not in ids for d in task['dependsOn']):
            raise ValueError('Unknown dependency: ' + task['id'])
    return data


def save(data):
    LEDGER.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def ready(task, tasks):
    return all(tasks[d]['status'] == 'accepted' for d in task['dependsOn'])


def audit(task):
    head = git_head()
    issues = []
    for criterion in task['acceptance']:
        evidence = criterion.get('evidence')
        if not evidence:
            issues.append(criterion['id'] + ': missing evidence')
            continue
        issues += verify_commit(evidence, criterion['id'], task['id'])
        if evidence.get('passed') is not True or not evidence.get('command'):
            issues.append(criterion['id'] + ': missing successful command record')
    if not task['acceptance']:
        issues.append('No acceptance criteria')
    review = task.get('review') or {}
    issues += verify_commit(review, 'review', task['id']) if review else ['Missing independent review']
    if review.get('approved') is not True:
        issues.append('Independent review is not explicitly approved')
    if not (review.get('reviewer')):
        issues.append('Missing independent reviewer')
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--', *IMPLEMENTATION_PATHS], cwd=ROOT, text=True)
    if dirty.strip():
        issues.append('Implementation working tree is dirty; evidence cannot certify uncommitted changes')
    return issues


def check_references():
    """检查归档目录与台账引用；历史材料仅核对存在，不升级历史结论。"""
    issues = []
    base = ROOT / 'docs' / 'acceptance'
    for package in base.iterdir():
        if not package.is_dir():
            continue
        for run in package.iterdir():
            if run.is_dir() and run.name != 'legacy' and not (run / 'manifest.json').is_file():
                issues.append(f'Missing manifest: {run.relative_to(ROOT)}')
    for task in load()['tasks']:
        records = [c.get('evidence') or c for c in task['acceptance']]
        records.append(task.get('review') or {})
        for record in records:
            if not record.get('report'):
                continue
            report = (ROOT / record['report']).resolve()
            if not report.is_relative_to(base.resolve()) or not report.is_file():
                issues.append(f"{task['id']}: invalid report reference")
            elif 'legacy' not in report.relative_to(base).parts:
                issues += verify_commit(record, 'review' if 'reviewer' in record else 'reference', task['id'])
    return issues


def main():
    parser = argparse.ArgumentParser(description='MVP evidence-based workflow')
    parser.add_argument('action', choices=('status', 'next', 'start', 'implemented', 'check', 'accept', 'reopen', 'references'))
    parser.add_argument('task', nargs='?')
    args = parser.parse_args()
    if args.action == 'references':
        issues = check_references()
        if issues:
            print('\n'.join(issues))
            raise SystemExit(1)
        print('Archive directories and ledger references passed; legacy status unchanged')
        return
    data = load()
    tasks = {t['id']: t for t in data['tasks']}
    if args.action == 'status':
        for t in data['tasks']:
            missing = sum(not c.get('evidence') for c in t['acceptance'])
            print(f"{t['id']:10} {t['status']:14} missing={missing} {t['title']}")
        return
    if args.action == 'next':
        active = [t for t in data['tasks'] if t['status'] == 'implementing']
        candidates = active or sorted((t for t in data['tasks'] if t['status'] in ('planned', 'ready') and ready(t, tasks)), key=lambda t: t['priority'])
        print(json.dumps(candidates[0] if candidates else {'message': 'No ready task; resolve dependencies or review implemented tasks'}, ensure_ascii=False, indent=2))
        return
    if args.task not in tasks:
        parser.error('Provide a valid task ID')
    t = tasks[args.task]
    if args.action == 'start':
        if t['status'] not in ('planned', 'ready') or not ready(t, tasks):
            raise ValueError('Task is not ready')
        if any(x['status'] == 'implementing' for x in tasks.values()):
            raise ValueError('Finish or reopen the active task first')
        t['status'] = 'implementing'
    elif args.action == 'implemented':
        if t['status'] != 'implementing':
            raise ValueError('Task must be implementing')
        t['status'] = 'implemented'
    elif args.action in ('check', 'accept'):
        issues = audit(t)
        if not ready(t, tasks):
            issues.append('Dependencies are not accepted')
        if issues:
            print('\n'.join(issues))
            raise SystemExit(1)
        if args.action == 'check':
            print('Evidence checks passed; this is not independent approval')
            return
        if t['status'] not in ('implemented', 'verified'):
            raise ValueError('Implementation must precede acceptance')
        t['status'] = 'accepted'
    elif args.action == 'reopen':
        t['status'] = 'planned'
        t['review'] = None
        for c in t['acceptance']:
            c['evidence'] = None
        # Invalidate dependent acceptance transitively.
        affected = {t['id']}
        while True:
            more = {x['id'] for x in tasks.values() if any(d in affected for d in x['dependsOn'])}
            if more <= affected:
                break
            affected |= more
        for identifier in affected - {t['id']}:
            if tasks[identifier]['status'] == 'accepted':
                tasks[identifier]['status'] = 'blocked'
                tasks[identifier]['review'] = None
    save(data)
    print(t['id'] + ': ' + t['status'])


if __name__ == '__main__':
    main()
