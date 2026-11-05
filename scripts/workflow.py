"""Repository-local task workflow; acceptance is evidence-based, never inferred from builds."""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / '.agent' / 'workflow.json'
EVIDENCE_TOOL = ROOT / 'scripts' / 'acceptance' / 'evidence.cjs'
IMPLEMENTATION_PATHS = ('schema-frontend', 'schema-platform', 'scripts', 'contract', 'sql')
STATES = ('planned', 'ready', 'implementing', 'implemented', 'verified', 'accepted', 'blocked')


def git_head():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def run_evidence_check(archive_rel):
    """调用项目归档校验工具；工具缺失/失败都视为校验失败，不静默降级。"""
    if not EVIDENCE_TOOL.is_file():
        return ['evidence tool missing: ' + str(EVIDENCE_TOOL)]
    proc = subprocess.run(['node', str(EVIDENCE_TOOL), 'check', archive_rel], cwd=ROOT,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        lines = [ln for ln in (proc.stdout + proc.stderr).splitlines() if ln.strip()]
        return lines or [f'archive check failed (exit={proc.returncode})']
    return []


def implementation_changed_between(source_commit, head):
    """源码提交与 HEAD 之间实现/测试路径是否有改动——有则证据失效，须重验。"""
    diff = subprocess.run(['git', 'diff', '--name-only', source_commit, head, '--', *IMPLEMENTATION_PATHS],
                          cwd=ROOT, capture_output=True, text=True)
    return [ln for ln in diff.stdout.splitlines() if ln.strip()]


def verify_commit(record, label):
    """校验证据提交：允许 manifest.sourceCommit ≠ HEAD（证据提交独立），但实现路径不得变化。"""
    issues = []
    head = git_head()
    commit = record.get('commit')
    report = (ROOT / record.get('report', '')).resolve()
    if (not report.is_relative_to(ROOT) or not report.is_file()
            or report.parts[-3:-2] == ('legacy',)):  # legacy 材料不得用于新验收
        return [f'{label}: report missing, outside repository, or legacy']
    manifest = None
    for parent in report.parents:
        candidate = parent / 'manifest.json'
        if candidate.is_file():
            manifest = json.loads(candidate.read_text(encoding='utf-8-sig'))
            break
    if manifest is None:
        issues.append(f'{label}: no manifest.json in report ancestry (docs/acceptance/<wp>/<run-id>/)')
        return issues
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
        issues += verify_commit(evidence, criterion['id'])
        if not evidence.get('passed') or not evidence.get('command'):
            issues.append(criterion['id'] + ': missing successful command record')
    if not task['acceptance']:
        issues.append('No acceptance criteria')
    review = task.get('review') or {}
    issues += verify_commit(review, 'review') if review else ['Missing independent review']
    if not (review.get('reviewer')):
        issues.append('Missing independent reviewer')
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--', *IMPLEMENTATION_PATHS], cwd=ROOT, text=True)
    if dirty.strip():
        issues.append('Implementation working tree is dirty; evidence cannot certify uncommitted changes')
    return issues


def main():
    parser = argparse.ArgumentParser(description='MVP evidence-based workflow')
    parser.add_argument('action', choices=('status', 'next', 'start', 'implemented', 'check', 'accept', 'reopen'))
    parser.add_argument('task', nargs='?')
    args = parser.parse_args()
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
