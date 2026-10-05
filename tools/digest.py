"""Turns of a Claude Code session transcript, one per prompt of the person: what was asked, what was then done."""
import json, re, sys, datetime as dt

path, out = sys.argv[1], sys.argv[2]
last_n = int(sys.argv[3]) if len(sys.argv) > 3 else 0
GAP_CAP = 10 * 60  # a silence longer than this is not working time

def clip(text, n):
    text = re.sub(r'\s+', ' ', text or '').strip()
    return text if len(text) <= n else text[: n - 1] + '…'

def stamp(row):
    ts = row.get('timestamp')
    return dt.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() if ts else None

def person_prompt(row):
    """The text the person typed, or None for a row that is not their prompt."""
    if row.get('type') != 'user' or row.get('isMeta') or row.get('isSidechain') or row.get('isCompactSummary'):
        return None
    content = (row.get('message') or {}).get('content')
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
            return None
        content = ' '.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
    if not isinstance(content, str) or not content.strip():
        return None
    text = content.strip()
    command = re.search(r'<command-name>(/[^<]+)</command-name>', text)
    if command:
        args = re.search(r'<command-args>([^<]*)</command-args>', text)
        return (command.group(1) + ' ' + (args.group(1) if args else '')).strip()
    if text.startswith('<') or text.startswith('[Request interrupted') or text.startswith('Caveat:'):
        return None
    return text

def describe(block):
    name, given = block.get('name', ''), block.get('input') or {}
    if name == 'Bash':
        return 'Bash: ' + clip(given.get('description') or given.get('command', ''), 70)
    if name in ('Read', 'Edit', 'Write', 'NotebookEdit'):
        return f"{name}: {str(given.get('file_path', '')).split('/')[-1]}"
    if name == 'Agent':
        return 'Agent: ' + clip(given.get('description', ''), 60)
    if name == 'Skill':
        return 'Skill: ' + str(given.get('skill', ''))
    return name

turns, current, previous = [], None, None
with open(path, errors='replace') as handle:
    for line in handle:
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get('isSidechain'):
            continue
        at = stamp(row)
        prompt = person_prompt(row)
        if prompt is not None:
            current = {'at': at, 'prompt': clip(prompt, 500), 'tools': [], 'answer': '', 'working_s': 0.0}
            turns.append(current)
            previous = at
            continue
        if current is None or at is None:
            continue
        if previous is not None:
            current['working_s'] += min(max(at - previous, 0), GAP_CAP)
        previous = at
        if row.get('type') == 'assistant':
            for block in (row.get('message') or {}).get('content') or []:
                if not isinstance(block, dict):
                    continue
                if block.get('type') == 'tool_use':
                    current['tools'].append(describe(block))
                elif block.get('type') == 'text' and block.get('text', '').strip():
                    current['answer'] = block['text']

if last_n:
    turns = turns[-last_n:]
digest = []
for index, turn in enumerate(turns):
    tools = turn['tools']
    shown = tools if len(tools) <= 8 else tools[:4] + [f'… {len(tools) - 8} more …'] + tools[-4:]
    digest.append({
        'i': index,
        'at': int(turn['at'] * 1000) if turn['at'] else 0,
        'when': dt.datetime.fromtimestamp(turn['at']).strftime('%d %b %H:%M') if turn['at'] else '',
        'prompt': turn['prompt'],
        'tool_calls': len(tools),
        'tools': shown,
        'answer': clip(turn['answer'], 12000),  # whole: the forks stand at the end of an answer
        'working_min': round(turn['working_s'] / 60),
    })
json.dump(digest, open(out, 'w'), ensure_ascii=False, indent=1)
print(f'{len(digest)} turns -> {out}; tool calls {sum(t["tool_calls"] for t in digest)}; working minutes {sum(t["working_min"] for t in digest)}')
