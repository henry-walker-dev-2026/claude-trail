"""The settlement pilot's ledger, from one session transcript.

For every track call that adds a decision (park, leave or next with "decide") while
decisions were already waiting, it records which decision ids the model had been shown
before the call (the latest "Decisions waiting" line in a prompt note or a tool result)
and which ids the call settled. At the end it lists the decisions still open, for the
eligibility audit by hand.

  python3 tools/settlement_audit.py <transcript.jsonl> [since ISO timestamp]

It reads only. Counts are of calls and ids, not of correctness: whether an exposed
decision was eligible for settlement is the audit's judgment, not this script's.
"""
import json, re, sys, datetime

path = sys.argv[1]
since = sys.argv[2] if len(sys.argv) > 2 else ''

def local(stamp):
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone().strftime('%m-%d %H:%M')

exposed = []          # ids named in the latest "Decisions waiting" line seen so far
exposed_at = None
calls = []
for line in open(path):
    try:
        row = json.loads(line)
    except ValueError:
        continue
    stamp = row.get('timestamp') or ''
    if stamp < since:
        continue
    kind = row.get('type')
    texts = []
    if kind == 'attachment':
        content = (row.get('attachment') or {}).get('content')
        texts = content if isinstance(content, list) else [str(content or '')]
    elif kind in ('user', 'assistant'):
        content = (row.get('message') or {}).get('content')
        if isinstance(content, list):
            for block in content:
                if block.get('type') == 'tool_result':
                    inner = block.get('content')
                    texts.append(' '.join(x.get('text', '') for x in inner if x.get('type') == 'text') if isinstance(inner, list) else str(inner))
                elif block.get('type') == 'tool_use' and block.get('name') == 'mcp__trail__track':
                    inp = block.get('input') or {}
                    decide = inp.get('decide') if isinstance(inp.get('decide'), list) else []
                    if inp.get('action') in ('park', 'leave', 'next') and decide and exposed:
                        calls.append({
                            'at': local(stamp), 'action': inp['action'], 'adds': decide,
                            'exposed': list(exposed), 'exposed_at': exposed_at,
                            'settled': inp.get('settled') if isinstance(inp.get('settled'), list) else [],
                        })
    for text in texts:
        for found in re.findall(r'Decisions waiting, settle by id what is taken: ([^\n]*)', text):
            exposed = re.findall(r'\[(p\d+)\]', found)
            exposed_at = local(stamp)

print(f'qualifying calls (a decision added while others were exposed): {len(calls)}')
with_settled = [c for c in calls if c['settled']]
print(f'of them naming settled ids: {len(with_settled)}; settled ids in all: {sum(len(c["settled"]) for c in with_settled)}')
for c in calls:
    print(f"  {c['at']} {c['action']:5s} adds {len(c['adds'])}; shown {len(c['exposed'])} ids at {c['exposed_at']}: {', '.join(c['exposed'][:8])}{' …' if len(c['exposed']) > 8 else ''}; settled: {', '.join(c['settled']) or '-'}")
print('last exposure:', exposed_at, ', '.join(exposed) if exposed else '(none yet)')
