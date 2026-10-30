"""Repository-local task workflow; acceptance is evidence-based, never inferred from builds."""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / '.agent' / 'workflow.json'
STATES = ('planned', 'ready', 'implementing', 'implemented', 'verified', 'accepted', 'blocked')


def git_head():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


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
        path = (ROOT / evidence['report']).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            issues.append(criterion['id'] + ': report missing or outside repository')
        if evidence.get('commit') != head:
            issues.append(criterion['id'] + ': evidence does not match HEAD')
        if not evidence.get('passed') or not evidence.get('command'):
            issues.append(criterion['id'] + ': missing successful command record')
    if not task['acceptance']:
        issues.append('No acceptance criteria')
    review = task.get('review') or {}
    report = (ROOT / review.get('report', '')).resolve()
    if (not review.get('approved') or review.get('commit') != head
            or not review.get('reviewer') or not report.is_relative_to(ROOT) or not report.is_file()):
        issues.append('Missing independent review for HEAD')
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--', 'schema-frontend', 'schema-platform', 'scripts', 'contract'], cwd=ROOT, text=True)
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
