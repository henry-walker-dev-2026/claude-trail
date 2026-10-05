// Replays a past session through the trail mod's own logic: a labeller decides,
// one turn at a time and without knowing what comes later, which trail actions
// the assistant should have issued; the mod's model.ts does the rest.
//
// This is a labelling estimate, not a simulation of the mod: the labeller sees
// the whole turn (its tool calls and its closing answer) before it decides, the
// live model decides call by call; and nothing here runs the hooks, the store
// or the pane. Read its counts as "about", never as measured behaviour.
//
//   bun replay.ts <digest.json> <out-prefix> [label] [timeline.json]
//
// With the timeline of an earlier run, its saved actions are applied again and
// the labeller is not asked: the same decisions through changed mod logic.

import {
  EMPTY,
  addSteps,
  advance,
  confirm,
  depthOf,
  enter,
  fix,
  kindOf,
  leave,
  paneRows,
  park,
  parkedOf,
  pathText,
  prompted,
  setGoal,
  statsText,
  tick,
  treeText,
  tripOf,
  unpark,
} from '../hooks/model.ts'

type Turn = {
  i: number
  at: number
  when: string
  prompt: string
  tool_calls: number
  tools: string[]
  answer: string
  working_min: number
}

type Action = {
  at: 'start' | 'end'
  action: string
  title?: string
  kind?: 'step' | 'detour'
  steps?: string[]
  titles?: string[]
  outcome?: string
  as?: 'done' | 'dropped' | 'open'
}

const [digestPath, prefix, label = 'session', earlierPath] = process.argv.slice(2)
const earlier: { timeline: { raw: Action[] }[] } | null =
  earlierPath === undefined ? null : await Bun.file(earlierPath).json()
const turns: Turn[] = await Bun.file(digestPath!).json()
const LIMITS = { depth: 2, minutes: 30, prompts: 5 }
const UNCONFIRMED_AFTER = 40

const SYSTEM = `You are replaying a past Claude Code session, one turn at a time, to test a tracking tool called "trail". Play the assistant of that session at the moment of the turn and decide which trail actions it should have issued. You know the trail so far and this one turn; you do not know what comes later.

The trail is the session painted as a tree, so that nothing the person asked for gets lost.
- The root is the session itself; it already exists. Never use action "goal" or "plan".
- A TASK is one piece of work the person asks for: a change, a run, a review, a question that needs real work. Start it with action "enter", kind "step", and a title of six words at most. Tasks sit directly under the root.
- When the person moves on to something else, close the current task first: "leave" as "done" with a one-line outcome if it is finished, as "open" if it is not (interrupted, waiting on something, answer still pending). "next" does both in one call: it closes the current task and enters the task named in "title"; give the outcome if the current task is finished, without an outcome it is left open.
- A DETOUR is work that interrupts the current task and after which the work returns to it: a blocker, a side investigation the task needs. Enter it with kind "detour"; it nests under the task. A new request that is not about the current task is a new task, never a detour.
- To continue something that was left open, enter it by its id. Never open a second node for the same work.
- A short follow-up about the current task (a clarification, "explain", "ok", "eta", a status question) needs no action.
- A FORK is anything the assistant raises and then leaves behind: something it noticed and did not look into, an option or a next step it offered that the person has not taken, a decision or a word it is waiting for from the person ("your call", "say go"). The person keeps this list so that no fork is forgotten. Park every fork the turn's closing answer leaves: action "park" at "end", with "titles" for several at once, each named by what is open ("Decide: merge the cache branch", "Trailing spaces in config keys, unchecked"), ten words at most.
- Park a fork once: one that is already on the list (same thing, whatever the wording) is not parked again. When the person takes a parked fork up, enter it by its id.
- The list is only worth reading while it is true, so close forks as carefully as you park them. In every turn, go through the parked items shown in THE TRAIL NOW: "unpark" at "end" ("titles" takes several ids) each one this turn settled, decided or overtook. A fork that changed shape is replaced: unpark the old wording when you park the new one.
- "fix": correct the current node's title or kind.

Replay rules:
- Each action carries "at": "start" when it would be issued as the prompt arrives, before the turn's work; "end" when it would be issued after the turn's work, when an outcome is known.
- Most turns need none, one or two actions besides parking. A task that starts and finishes in the same turn is entered at "start" and left at "end".
- Titles are six words at most, plain words, no file paths. Refer to existing nodes and parked items by their id.`

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          at: { type: 'string', enum: ['start', 'end'] },
          action: {
            type: 'string',
            enum: ['goal', 'plan', 'enter', 'next', 'leave', 'park', 'unpark', 'fix'],
          },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['step', 'detour'] },
          steps: { type: 'array', items: { type: 'string' } },
          titles: { type: 'array', items: { type: 'string' } },
          outcome: { type: 'string' },
          as: { type: 'string', enum: ['done', 'dropped', 'open'] },
        },
        required: ['at', 'action'],
      },
    },
  },
  required: ['actions'],
})

let trail = setGoal(EMPTY, 'Session', turns[0]?.at ?? 0)
let cost = 0
let callsSinceUpdate = 0
const timeline: object[] = []
const trips: object[] = []
const nudges: object[] = []
const goals: string[] = []
const recent: string[] = []
const denied: string[] = []
const episodes: { from: Turn; to?: Turn; prompts: number; minutes: number; maxDepth: number; titles: string[] }[] = []
let actionCount = 0
let detourTurns = 0
let detourMinutes = 0

/** The trail as the labeller sees it: whole while short, else what is open plus the latest closed nodes. */
const shown = (): string => {
  if (trail.nodes.length === 0) {
    return 'No goal is set.'
  }

  const whole = treeText(trail)

  if (whole.length <= 3500) {
    return whole
  }

  const closed = trail.nodes.filter(node => node.state === 'done' || node.state === 'dropped')
  const hidden = new Set(closed.slice(0, Math.max(0, closed.length - 8)).map(node => `[${node.id}]`))

  return [
    `(${hidden.size} earlier closed nodes are not shown)`,
    ...whole.split('\n').filter(line => ![...hidden].some(id => line.includes(` ${id}`))),
  ].join('\n')
}

const ask = async (turn: Turn): Promise<Action[]> => {
  const prompt = [
    'THE TRAIL NOW',
    shown(),
    trail.cursor === null ? '' : `Now on: ${pathText(trail)} (${statsText(trail)})`,
    '',
    recent.length > 0 ? `RECENT TURNS, ALREADY HANDLED\n${recent.slice(-3).join('\n')}\n` : '',
    `THIS TURN (#${turn.i}, ${turn.when})`,
    `The person: "${turn.prompt}"`,
    turn.tool_calls === 0
      ? 'The assistant answered without tool calls.'
      : `The assistant then made ${turn.tool_calls} tool calls over about ${turn.working_min} working minutes:\n${turn.tools.map(tool => `- ${tool}`).join('\n')}`,
    `and ended with: "${turn.answer.length <= 6000 ? turn.answer : `${turn.answer.slice(0, 1500)} […] ${turn.answer.slice(-4500)}`}"`,
    '',
    'Which trail actions belong to this turn?',
  ].join('\n')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const run = Bun.spawn(
      ['claude', '-p', '--model', 'sonnet', '--no-session-persistence', '--disable-slash-commands', '--tools', '', '--system-prompt', SYSTEM, '--output-format', 'json', '--json-schema', SCHEMA, prompt],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    )
    const raw = await new Response(run.stdout).text()

    await run.exited

    try {
      const answer = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))

      cost += Number(answer.total_cost_usd ?? 0)

      if (Array.isArray(answer.structured_output?.actions)) {
        return answer.structured_output.actions
      }
    } catch {
      // asked again below
    }
  }

  denied.push(`#${turn.i}: the labeller gave no usable answer three times`)

  return []
}

const trip = (turn: Turn, phase: string) => {
  const reason = tripOf(trail, LIMITS)

  if (reason !== null) {
    trips.push({ turn: turn.i, when: turn.when, phase, reason, path: pathText(trail), prompt: turn.prompt.slice(0, 160) })
    trail = { ...trail, isTripped: true }
  }
}

const apply = (turn: Turn, one: Action) => {
  const title = (one.title ?? '').trim()
  const outcome = (one.outcome ?? '').trim() === '' ? null : (one.outcome ?? '').trim()
  // An action at the end of the turn happens after the turn's work, not at its prompt.
  const now = one.at === 'start' ? turn.at : turn.at + turn.working_min * 60_000

  if (one.action !== 'goal' && trail.cursor === null) {
    denied.push(`#${turn.i}: ${one.action} «${title}» with no goal set`)

    return
  }

  const forks = [title, ...(one.titles ?? [])].map(each => each.trim()).filter(each => each !== '')

  if (one.action === 'park' && forks.length === 0) {
    denied.push(`#${turn.i}: park without a title`)

    return
  }

  if (['goal', 'enter', 'next'].includes(one.action) && title === '') {
    denied.push(`#${turn.i}: ${one.action} without a title`)

    return
  }

  // The refusals of the tool hook in register.tsx, in the same order.
  if (one.action === 'enter' && one.kind === undefined && kindOf(trail, title) === null) {
    denied.push(`#${turn.i}: enter «${title}» without a kind`)

    return
  }

  if (one.action === 'leave' && trail.nodes.find(node => node.id === trail.cursor)?.parentId === null) {
    denied.push(`#${turn.i}: leave with no task open`)

    return
  }

  switch (one.action) {
    case 'goal':
      if (trail.cursor === null && trail.nodes.length > 0) {
        goals.push(treeText(trail))
      }

      trail = setGoal(trail, title, now)
      break
    case 'plan':
      trail = addSteps(trail, one.steps ?? [])
      break
    case 'enter':
      trail = enter(trail, title, one.kind ?? kindOf(trail, title) ?? 'step', now)
      break
    case 'next':
      trail = advance(trail, title, one.kind ?? 'step', outcome, now, one.as)
      break
    case 'leave':
      trail = leave(trail, one.as ?? 'done', outcome, now)
      break
    case 'park':
      trail = forks.reduce((kept, fork) => park(kept, fork, now), trail)
      break
    case 'unpark':
      if (!forks.some(each => parkedOf(trail, each) !== undefined)) {
        denied.push(`#${turn.i}: unpark «${forks.join(', ')}» names no parked item`)

        return
      }

      trail = forks.reduce(unpark, trail)
      break
    case 'fix':
      trail = fix(trail, title === '' ? null : title, one.kind ?? null)
      break
    default:
      trail = confirm(trail)
  }

  actionCount += 1
  callsSinceUpdate = 0
  trip(turn, `after ${one.action}`)
}

const text = (one: Action) =>
  [one.action, one.kind, one.title && `«${one.title}»`, one.steps && `[${one.steps.join(' | ')}]`, one.titles && `[${one.titles.join(' | ')}]`, one.as && one.as !== 'done' && `as ${one.as}`, one.outcome && `(${one.outcome})`]
    .filter(Boolean)
    .join(' ')

for (const turn of turns) {
  if (trail.cursor !== null) {
    trail = prompted(trail)
    trip(turn, 'as the prompt arrived')
  }

  const actions = earlier === null ? await ask(turn) : (earlier.timeline[turn.i]?.raw ?? [])

  for (const one of actions.filter(action => action.at === 'start')) {
    apply(turn, one)
  }

  const depth = depthOf(trail)
  const open = episodes.at(-1)

  if (depth > 0) {
    detourTurns += 1

    if (open === undefined || open.to !== undefined) {
      episodes.push({ from: turn, prompts: 1, minutes: 0, maxDepth: depth, titles: [] })
    } else {
      open.prompts += 1
      open.maxDepth = Math.max(open.maxDepth, depth)
    }
  }

  for (let minute = 0; minute < turn.working_min; minute += 1) {
    if (depthOf(trail) > 0) {
      detourMinutes += 1

      const running = episodes.at(-1)

      if (running !== undefined && running.to === undefined) {
        running.minutes += 1
      }
    }

    trail = tick(trail)
    trip(turn, `${minute + 1} min into the turn`)
  }

  callsSinceUpdate += turn.tool_calls

  if (trail.cursor !== null && callsSinceUpdate >= UNCONFIRMED_AFTER) {
    nudges.push({ turn: turn.i, when: turn.when, calls: callsSinceUpdate, path: pathText(trail) })
    callsSinceUpdate = 0
  }

  for (const one of actions.filter(action => action.at !== 'start')) {
    apply(turn, one)
  }

  const running = episodes.at(-1)

  if (running !== undefined && running.to === undefined) {
    for (const one of actions) {
      if ((one.action === 'enter' || one.action === 'next') && one.kind === 'detour' && one.title) {
        running.titles.push(one.title)
      }
    }

    running.maxDepth = Math.max(running.maxDepth, depthOf(trail))

    if (depthOf(trail) === 0) {
      running.to = turn
    }
  }

  const done = actions.map(text).join('; ')

  recent.push(`#${turn.i} "${turn.prompt.slice(0, 140)}" -> ${done || 'no action'}`)
  timeline.push({ turn: turn.i, when: turn.when, depth: depthOf(trail), path: pathText(trail), prompt: turn.prompt.slice(0, 200), actions: actions.map(text), raw: actions, tools: turn.tool_calls, minutes: turn.working_min, pane: paneRows(trail, [], turn.at + turn.working_min * 60_000, 58).map(row => row.text) })
  console.log(`#${turn.i} ${turn.when} d${depthOf(trail)} ${pathText(trail).slice(0, 90)} | ${done.slice(0, 160)}`)
}

if (trail.nodes.length > 0) {
  goals.push(treeText(trail))
}

const toolCalls = turns.reduce((sum, turn) => sum + turn.tool_calls, 0)
const minutes = turns.reduce((sum, turn) => sum + turn.working_min, 0)
const report = [
  `SESSION ${label}: ${turns.length} prompts, ${turns[0]?.when} to ${turns.at(-1)?.when}, ${toolCalls} tool calls, ${minutes} working minutes`,
  `Trail actions the labeller issued: ${actionCount} (labelling cost $${cost.toFixed(2)})`,
  `Off the main line: ${detourTurns} of ${turns.length} prompts, ${detourMinutes} of ${minutes} working minutes`,
  '',
  `TRIPWIRE: would have fired ${trips.length} times`,
  ...trips.map((one: any) => `  #${one.turn} ${one.when}, ${one.phase}: ${one.reason}\n      path: ${one.path}\n      prompt: "${one.prompt}"`),
  '',
  `NUDGES after ${UNCONFIRMED_AFTER} tool calls without a trail update: ${nudges.length}`,
  ...nudges.map((one: any) => `  #${one.turn} ${one.when}: ${one.calls} calls on ${one.path}`),
  '',
  `DETOUR EPISODES: ${episodes.length}`,
  ...episodes.map(one => `  #${one.from.i}–#${one.to?.i ?? 'end'} (${one.from.when} – ${one.to?.when ?? 'still open'}): ${one.prompts} prompts, ${one.minutes} working min, depth ${one.maxDepth}: ${one.titles.join(' › ') || '(entered earlier)'}`),
  '',
  denied.length > 0 ? `REFUSED OR FAILED ACTIONS: ${denied.length}\n${denied.map(line => `  ${line}`).join('\n')}\n` : '',
  'TURN BY TURN',
  ...timeline.map((row: any) => `  #${String(row.turn).padStart(3)} ${row.when} d${row.depth} ${row.tools.toString().padStart(3)}c "${row.prompt.slice(0, 70)}"\n        ${row.actions.join('; ') || '-'}\n        => ${row.path || '(no goal)'}`),
  '',
  `TRAILS (${goals.length})`,
  ...goals.map((tree, index) => `--- trail ${index + 1}\n${tree}`),
].join('\n')

await Bun.write(`${prefix}.report.txt`, report)
await Bun.write(`${prefix}.pane.txt`, paneRows(trail, [], (turns.at(-1)?.at ?? 0) + (turns.at(-1)?.working_min ?? 0) * 60_000, 58).map(row => row.text).join('\n'))
await Bun.write(`${prefix}.timeline.json`, JSON.stringify({ timeline, trips, nudges, episodes, denied, cost }, null, 1))
console.log(`done: ${prefix}.report.txt, cost $${cost.toFixed(2)}`)
