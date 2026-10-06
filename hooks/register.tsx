import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput } from 'claude-code'

import {
  addSteps,
  advance,
  confirm,
  countsText,
  decisionsText,
  depthOf,
  dropFork,
  EMPTY,
  enter,
  fix,
  forksText,
  fullText,
  kindOf,
  leave,
  markAsk,
  moveFork,
  noteText,
  paneRows,
  park,
  parkedOf,
  pathOf,
  pathText,
  prompted,
  resolveTarget,
  runningOf,
  setGoal,
  STALE_AFTER,
  statsText,
  stripRows,
  tick,
  tidy,
  TOOL,
  treeText,
  tripOf,
  tripText,
  unconfirmedText,
  unpark,
} from './model'
import type { Limits, PaneRow } from './model'
import type { Trail, TrailWork, TrailWorkState } from '../types'

const trail = atom({ plugin: 'trail', key: 'trail' } as const, EMPTY)
const work = atom({ plugin: 'trail', key: 'work' } as const, [])
/** The fork opened up in the pane, by id. */
const opened = atom({ plugin: 'trail', key: 'opened' } as const, null)
/** Which page of the whole tree the band above the prompt shows; 0 is the strip. */
const page = atom({ plugin: 'trail', key: 'page' } as const, 0)
/** The nodes whose folded closed branches are shown, by id. */
const unfolded = atom({ plugin: 'trail', key: 'unfolded' } as const, [])

/** The side pane that draws the tree. */
const PANE = 'trail'

/** Pieces of parallel work the pane remembers. */
const WORK_KEPT = 200

/** The tools whose result names a background task, and what the pane calls it. */
const BACKGROUND: Record<string, TrailWork['kind']> = {
  Bash: 'shell',
  Monitor: 'monitor',
  Workflow: 'workflow',
}

/** The kinds of parallel work that are agent loops the engine lists. */
const AGENTS = new Set<TrailWork['kind']>(['agent', 'fork', 'teammate'])

/** The longest a Monitor watches before the engine ends it: one "running" longer than this has expired unheard. */
const MONITOR_CAP = 30 * 60_000

const ENDED: Record<string, TrailWorkState> = {
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
  stopped: 'stopped',
}

/** Theme keys, so the pane follows the person's theme. */
const TONE_COLORS: Partial<Record<PaneRow['tone'], string>> = {
  title: 'suggestion',
  warn: 'warning',
  ask: 'claude',
  note: 'suggestion',
  done: 'success',
  run: 'suggestion',
  fail: 'error',
}

/** How a row of the pane is drawn; a prop is named only where it applies. */
const lookOf = (tone: PaneRow['tone']) => ({
  wrap: 'truncate-end' as const,
  ...(tone === 'here' && { inverse: true }),
  ...((tone === 'here' || tone === 'open' || tone === 'run' || tone === 'title' || tone === 'ask') && { bold: true }),
  ...((tone === 'done' || tone === 'dim' || tone === 'head') && { dimColor: true }),
  ...(TONE_COLORS[tone] !== undefined && { color: TONE_COLORS[tone] }),
})

type Fork = NonNullable<PaneRow['act']>

/** The rows the tree may take above the prompt before it is cut: a sixth of the screen, six at least. */
const roomOf = () => (screenRows === null ? 8 : Math.max(6, Math.floor(screenRows / 6)))

/** Opens the tree as a pane of its own, when the person asks for one: a side pane where the layout docks it. */
const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Trail', rows: roomOf() })

/** A leave or a next carries the forks of the node it closes: noted and filed under it in the same call. */
const withForks = (kept: Trail, under: string | null, notes: string[], asks: string[], now: number): Trail =>
  asks.reduce(
    (held, fork) => (parkedOf(held, fork) === undefined ? park(held, fork, now, under, true) : markAsk(held, fork)),
    notes.reduce((held, fork) => park(held, fork, now, under), kept),
  )

/** A press on "N earlier, closed" shows those branches, a second one folds them again. */
const unfold = ($: EngineInterface, id: string) =>
  update($, unfolded, held => (held.includes(id) ? held.filter(one => one !== id) : [...held, id]))

/** A press on a fork opens it up in the pane, a second one closes it; nothing else happens. */
const toggle = ($: EngineInterface, id: string) =>
  update($, opened, held => (held === id ? null : id))

/**
 * "take up" puts the fork into the prompt box and sends nothing: Enter is the
 * person's. Into a draft already begun it goes as a reference at the cursor.
 */
const take = async ($: EngineInterface, fork: Fork) => {
  const draft = await $.prompt.read()

  await $.prompt.fill(
    draft.text.trim() === ''
      ? { text: `do ${fork.id}: ${fork.title}` }
      : { text: `${fork.id} (${fork.title}) `, mode: 'insert' },
  )
  await update($, opened, () => null)
}

/** Sessions whose trail the store keeps; older ones are deleted. */
const KEPT_SESSIONS = 30

/** Main-loop tool calls without a trail update after which the model is asked to confirm. */
const UNCONFIRMED_AFTER = 40

/** What the root of the tree is called until the person names it. */
const ROOT = 'Session'

const USAGE = `# Trail

The person turned on a mod named trail. It paints this session as a tree in a side pane, so that nothing they asked for gets lost and side tracks stay visible. You keep the tree true through the ${TOOL} tool. Only the main conversation does; a subagent never calls it.

- The root is the session; it already exists.
- A task is one piece of work the person asks for: a change, a run, a review, a question that needs real work. action "enter", kind "step", before you start on it. A new task goes under the root even while another is open: the one still open is left open, named in the result, and continued later by its id or closed with "leave". A step that belongs to the task at hand says so: "under" with that task's id.
- action "leave" when the current task ends: as "done" with a one-line outcome, as "open" if it is not finished (interrupted, waiting on something, an answer still pending), as "dropped" if it is given up. action "next" does both in one call: it closes the current node and enters the one named in "title". Give the outcome if the current node is finished; without an outcome it is left open.
- To continue something that was left open, enter it by its id. Never open a second node for the same work.
- A task of several steps: action "plan" lists them under the task; enter and leave them like tasks.
- A detour is work that interrupts the current task and after which you return to it: a blocker, a side investigation the task needs. action "enter", kind "detour". A new request that is not about the current task is a new task, not a detour.
- A short follow-up about the current task (a clarification, a status question) needs no call.
- Keep it cheap. A trail call that stands alone in a step costs the person a whole extra request, so send trail calls in the same step as your other tool calls. Close a task with ONE call: "leave" or "next" takes the forks it leaves behind in "titles" and "decide". If the outcome is only clear after the turn's last tool result, do not spend a step on the trail: close the task in the first step of the next turn, along with what you do then. The tree may lag by a turn. A step for the trail alone is right only when the person asks about the trail.
- A fork is anything you raise and then leave behind: something you noticed and did not look into, an option or a next step you offered that the person has not taken, a decision or a word you are waiting for from them ("your call", "say go"). The person keeps this list so that no fork is forgotten, and a fork that stands only in your answer is lost. So park every fork in the turn you write it, before you leave the task it came out of, so that it hangs under that task: action "park", each fork named by what is open, ten words at most. The forks that wait for the person's word (a decision, a go, an answer) go in "decide" (["Merge the cache branch", "Keep or drop the old parser"]); everything else, noticed or offered and left, goes in "titles" (["Trailing spaces in config keys, unchecked"]). The pane shows the two apart, so say it by the list, not by the wording. A fork already parked that turns out to wait for the person is marked by naming its id in "decide".
- A fork hangs in the tree under the task it belongs to; by default that is the task at hand. One that is not about that task (a standing decision, something from earlier in the session) goes under the session: "under": "session". One that belongs to another task goes under that task's id. A fork that hangs in the wrong place is moved by parking it again by its id with "under".
- Park a fork once; when it comes up again it is already on the list. When the person takes it up, enter it by its id.
- When the person asks what is open, or refers to a task or a fork by its id ("do p20", "drop p16"), action "show" returns the whole tree with every id. Answer from that, not from memory, and name each item with its id. A prompt that only names a fork, without saying what to do with it, is a question about it: say what it is and what the choices are, and do not start on it.
- The list is only worth reading while it is true, so close forks as carefully as you park them. Whenever a task ends, the result lists the open forks: action "unpark" ("titles" takes several ids) for each one that was settled, decided or overtaken. A fork that changed shape is replaced: unpark the old wording when you park the new one.
- A fork that a call settles, a decision taken or an offer overtaken, goes by id in "settled" on that park, leave or next: it is closed in the same change, no separate unpark. The note before each prompt lists the decisions waiting with their ids; before you park a new decision, settle the one it replaces.
- action "fix": correct the current node's title or kind. action "goal": give the root a better name, six words at most, when the session is about one big thing.

Titles are read in a narrow side pane: six words at most, plain words, no file paths, no trailing detail.

Keep the trail true rather than tidy: a task left open is not a failure, an unreported one is. When a trail note says the tripwire fired, stop and ask the person what it says to ask, in plain words, without naming the trail or the tripwire.

Write nothing about the trail to the person, not even in passing ("updating the tracker", "closing out the bookkeeping"): a side pane shows it, so call the tool without a sentence around it. Mention the trail only when the person asks about it.`

/** Which version of the rules above a session's model has read: their length and a checksum. */
const RULES = `${USAGE.length}:${[...USAGE].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1_000_000_007, 7)}`

const COMMAND_HELP =
  'Usage: /trail (turn the trail on) · /trail off · /trail text (print the trail) · /trail pane (the tree as a pane of its own) · /trail close · /trail goal <text> (name the session) · /trail park <text> · /trail unpark <id> · /trail back (leave the current node open and return) · /trail done [outcome] · /trail drop [reason] · /trail clear'

/** The ways the person ends the current node by hand. */
const ENDINGS: Record<string, { as: 'done' | 'dropped' | 'open'; says: string }> = {
  back: { as: 'open', says: 'is left open' },
  done: { as: 'done', says: 'is done' },
  drop: { as: 'dropped', says: 'is dropped' },
}

const TOOL_DESCRIPTION =
  'Keeps the tree of this session true: tasks, their steps, detours, and the forks left open. Call it only while the person has the trail on; the instructions arrive when they turn it on. The result is the current path.'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'goal',
        'plan',
        'enter',
        'next',
        'leave',
        'park',
        'unpark',
        'confirm',
        'fix',
        'show',
      ],
    },
    title: {
      type: 'string',
      description:
        'Six words at most. goal, park, fix: a short title. enter, next: the id or title of a planned step, of a node left open or of a parked item, or the title of a new node. unpark: the id or title of a parked item.',
    },
    kind: {
      type: 'string',
      enum: ['step', 'detour'],
      description:
        'enter, next, fix: a planned step or an unplanned detour. next defaults to step.',
    },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'plan: the step titles, in order.',
    },
    titles: {
      type: 'array',
      items: { type: 'string' },
      description:
        'park, leave, next: forks noticed or offered and left, one title each. unpark: several ids in one call.',
    },
    decide: {
      type: 'array',
      items: { type: 'string' },
      description:
        "park, leave, next: the forks that wait for the person's word (a decision, a go, an answer), one title each. The id of a fork already parked marks that fork as one.",
    },
    under: {
      type: 'string',
      description:
        'park: where the forks belong when that is not the task at hand: "session", or the id of a task. Given with the id of a fork already parked, it moves that fork there. enter, next: where a new node goes when not under the root: the id of the task it is a step of.',
    },
    settled: {
      type: 'array',
      items: { type: 'string' },
      description:
        'park, leave, next: the ids of waiting forks this call settles (a decision taken, an offer overtaken); they are closed in the same change. The note before each prompt lists the decisions waiting.',
    },
    outcome: {
      type: 'string',
      description: 'leave, next: one line on how the current node ended.',
    },
    as: {
      type: 'string',
      enum: ['done', 'dropped', 'open'],
      description: 'leave, next: finished, given up, or left open to pick up later. leave defaults to done; next defaults to done with an outcome and to open without one.',
    },
  },
  required: ['action'],
}

const isTrail = (value: unknown): value is Trail =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as Trail).nodes) &&
  Array.isArray((value as Trail).parked)

const limitOf = (value: unknown, fallback: number) => {
  const limit = Math.floor(Number(value))

  return Number.isFinite(limit) && limit >= 1 ? limit : fallback
}

// What a reload may lose without harm: it is rebuilt or merely delays a note.
let limits: Limits = { depth: 2, minutes: 30, prompts: 5 }
let isWorking = false
let isTicking = false

/** The trail is on: it has a root. Off, the mod adds nothing to the session. */
let hasTrail = false
let calls = 0
let alarm: string | null = null
let isFullDue = false
/** The terminal's height as last drawn, to size the tree; unknown until something was drawn. */
let screenRows: number | null = null
/**
 * True while the tree is drawn in a pane docked beside the transcript, which
 * the person opened with /trail pane: the band then keeps to its line of
 * counts. In every other case the band above the prompt is where the tree is.
 */
let isPaneDocked = false

/** What the last note said of the path and of what is left open: the next one is sent only if it differs. */
let lastTold: string | null = null

/** The task left in this turn: a fork parked right after still belongs under it, not under the session. */
let justLeft: string | null = null
let carried: Trail | null = null

/** Whether the tool is registered and the clock ticks: only while the trail is on. */
let isAwake = false
let ticker: { cancel: () => void } | null = null
let saving: Promise<void> = Promise.resolve()

/** Writes the tree and the parallel work as they stand now; one write after the other, so an older one never lands last. */
const save = ($: EngineInterface): Promise<void> => {
  saving = saving.then(async () => {
    try {
      const id = await $.session.id()

      await $.store.set(`trail:${id}`, await read($, trail))
      await $.store.set(`work:${id}`, await read($, work))
    } catch (error) {
      $.ui.log(`trail: not saved (${String(error)})`, { to: 'debug' })
    }
  })

  return saving
}

const change = async (
  $: EngineInterface,
  apply: (held: Trail) => Trail,
): Promise<Trail> => {
  const held = await update($, trail, apply)

  hasTrail = held.cursor !== null
  calls = 0
  await save($)

  return held
}

/** Nothing is owed to Claude any more: the tree it was about is gone. */
/** "drop" takes the fork off the list at once, without a turn of the model; a toast says which, in case of a slip. */
const drop = async ($: EngineInterface, fork: Fork) => {
  const now = await $.clock.now()

  await change($, one => dropFork(one, fork.id, now))
  await update($, opened, () => null)
  $.ui.toast(`Trail: dropped ${fork.id} «${fork.title}»`)
}

const forget = async ($: EngineInterface) => {
  calls = 0
  alarm = null
  isFullDue = false
  justLeft = null
  lastTold = null
  await update($, work, () => [])
  await update($, opened, () => null)
  await update($, unfolded, () => [])
  await update($, page, () => 0)
}

/** A piece of parallel work started. */
const started = async ($: EngineInterface, item: TrailWork) => {
  await update($, work, list =>
    [...list.filter(one => one.id !== item.id), item].slice(-WORK_KEPT),
  )
  await save($)
}

/** A piece of parallel work ended, if it was still known as going, or its end had gone unheard. */
const ended = async (
  $: EngineInterface,
  id: string,
  how: (item: TrailWork) => TrailWorkState,
  now: number,
) => {
  if ((await read($, work)).some(item => item.id === id)) {
    await update($, work, list =>
      list.map(item =>
        item.id === id && (item.state === 'running' || item.state === 'idle' || item.state === 'unknown')
          ? { ...item, state: how(item), endedAt: now }
          : item,
      ),
    )
    await save($)
  }
}

/**
 * An agent's turn is over, for good or until a message wakes it: what it started and never
 * saw end goes unknown, since those ends are told to it, never here. A notice that does
 * reach here later still sets the record straight.
 */
const orphan = async ($: EngineInterface, parentId: string) => {
  const held = await read($, work)

  if (held.some(item => item.parentId === parentId && item.state === 'running')) {
    await update($, work, list =>
      list.map(item =>
        item.parentId === parentId && item.state === 'running' ? { ...item, state: 'unknown' as const } : item,
      ),
    )
    await save($)
  }
}

/**
 * The pane never says "running" of what it cannot know to run: an agent the
 * engine no longer lists, a job started inside such an agent, a shell of an
 * earlier process, a job whose task was given up and whose end went unheard,
 * a Monitor older than the longest watch the engine allows.
 */
const reconcile = async ($: EngineInterface, isNewProcess: boolean) => {
  const held = await read($, work)

  if (!held.some(item => item.state === 'running')) {
    return
  }

  // The engine keeps listing an agent after its end, with that end as its status: only one not ended is live.
  // And only one in a turn (or about to start one) can hear the ends of the jobs it started: an idle teammate cannot.
  const agents = await $.agent.list()
  const live = new Set(
    agents
      .filter(agent => agent.status !== 'completed' && agent.status !== 'failed' && agent.status !== 'killed')
      .map(agent => agent.id),
  )
  const hearing = new Set(
    agents
      .filter(agent => agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting')
      .map(agent => agent.id),
  )
  const givenUp = new Set((await read($, trail)).nodes.filter(node => node.state === 'dropped').map(node => node.id))
  const now = await $.clock.now()
  const isLost = (item: TrailWork) =>
    AGENTS.has(item.kind)
      ? !live.has(item.id)
      : isNewProcess ||
        (item.nodeId !== null && givenUp.has(item.nodeId)) ||
        (item.parentId !== null && !hearing.has(item.parentId)) ||
        (item.kind === 'monitor' && now - item.startedAt > MONITOR_CAP)
  const seen = held.map(item => (item.state === 'running' && isLost(item) ? { ...item, state: 'unknown' as const } : item))

  if (seen.some((item, index) => item !== held[index])) {
    await update($, work, () => seen)
    await save($)
  }
}

/** Arms the tripwire's note when a limit is crossed; it reaches the model at the next delivery point. */
const check = async ($: EngineInterface, held: Trail): Promise<Trail> => {
  const reason = tripOf(held, limits)

  if (reason === null) {
    return held
  }

  alarm = tripText(held, reason)

  const tripped = await update($, trail, one => ({ ...one, isTripped: true }))

  await save($)

  return tripped
}

/** Takes what is owed to the model, at once, so that two results finishing together never both hand it over. */
const claim = () => {
  const owed = { alarm, isFull: isFullDue }

  alarm = null
  isFullDue = false

  return owed
}

const notesOf = (held: Trail, owed: { alarm: string | null; isFull: boolean }): string[] => [
  ...(owed.alarm === null ? [] : [owed.alarm]),
  ...(owed.isFull ? [`${USAGE}\n\n${fullText(held)}`] : []),
]

/** After a /clear the conversation is new and the work is not: the trail carries over, and Claude is told the rules and the tree again. */
const adopt = async ($: EngineInterface) => {
  const kept = carried

  carried = null

  if (kept !== null && kept.cursor !== null && (await read($, trail)).cursor === null) {
    await change($, () => kept)
    isFullDue = true
  }
}

const minute = async ($: EngineInterface) => {
  if (isTicking) {
    return
  }

  isTicking = true

  try {
    // Running times in the pane move with the clock, not with the state.
    if (runningOf(await read($, work)) > 0) {
      $.ui.invalidate('ui.render')
    }

    if (isWorking && hasTrail && depthOf(await read($, trail)) > 0) {
      await check($, await update($, trail, tick))
      await save($)
    }
  } catch (error) {
    $.ui.log(`trail: ${String(error)}`, { to: 'debug' })
  } finally {
    isTicking = false
  }
}

/**
 * The trail is on: the tool is offered, the clock ticks, the session is in the
 * store's index. Until then the mod adds nothing to a session.
 */
const wake = async ($: EngineInterface) => {
  if (isAwake) {
    return
  }

  await $.tool.register({
    name: 'track',
    description: TOOL_DESCRIPTION,
    inputSchema: TOOL_SCHEMA,
  })

  const id = await $.session.id()
  const listed = await $.store.get('index')
  const index = [
    id,
    ...(Array.isArray(listed) ? listed : []).filter(one => one !== id),
  ]

  for (const old of index.slice(KEPT_SESSIONS)) {
    await $.store.delete(`trail:${String(old)}`)
    await $.store.delete(`work:${String(old)}`)
    await $.store.delete(`rules:${String(old)}`)
  }

  await $.store.set('index', index.slice(0, KEPT_SESSIONS))
  ticker = $.clock.every(60_000, () => {
    void minute($)
  })
  isAwake = true
}

/** The trail is off: the clock stops. The engine has no way to take a registered tool back; its calls are refused. */
const halt = () => {
  ticker?.cancel()
  ticker = null
  isAwake = false
}

/**
 * The rows of the tree as elements, the same in the docked pane and in the
 * band above the prompt: a fork row and the closed row are pressable.
 */
const drawRows = ($: EngineInterface, e: ResolveInput<'Pane' | 'AbovePrompt'>, rows: PaneRow[]) => {
  const { Box, Button, Text } = $.ui.resolve(e)

  return rows.map(row => {
    const { fork, act, fold } = row

    if (fold !== undefined) {
      return (
        <Box>
          <Text dimColor>{row.text.slice(0, fold.at)}</Text>
          <Button
            plain
            dimColor
            key={`fold:${fold.id}`}
            label={row.text.slice(fold.at)}
            onPress={() => unfold($, fold.id)}
          />
        </Box>
      )
    }

    if (act !== undefined) {
      return (
        <Box>
          <Text dimColor>{row.text}</Text>
          <Button key={`take:${act.id}`} label="take up" onPress={() => take($, act)} />
          <Text>{'  '}</Text>
          <Button key={`drop:${act.id}`} label="drop" onPress={() => drop($, act)} />
        </Box>
      )
    }

    // Every row of an open fork is pressable, so the whole entry is the target.
    // A Button takes no color, so the mark in front of it carries the fork's.
    return fork === undefined ? (
      <Text {...lookOf(row.tone)}>{row.text === '' ? ' ' : row.text}</Text>
    ) : (
      <Box>
        <Text dimColor>{row.text.slice(0, fork.at)}</Text>
        <Text {...lookOf(row.tone)}>{row.text.slice(fork.at, fork.at + 2)}</Text>
        <Button
          plain
          key={`fork:${fork.id}:${fork.line}`}
          label={row.text.slice(fork.at + 2)}
          onPress={() => toggle($, fork.id)}
        />
      </Box>
    )
  })
}

export const register: Register = (on, options) => {
  limits = {
    depth: limitOf(options.detourDepth, 2),
    minutes: limitOf(options.detourMinutes, 30),
    prompts: limitOf(options.detourPrompts, 5),
  }
  isWorking = false
  isTicking = false
  hasTrail = false
  calls = 0
  alarm = null
  isFullDue = false
  carried = null
  isAwake = false
  ticker = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'trail',
      description: 'Turn the trail on for this session, show it, or correct it',
      argumentHint: '[off | text | pane | close | goal <text> | park <text> | unpark <id> | back | done | drop | clear]',
      immediate: true,
    })

    const id = await $.session.id()
    let held = await read($, trail)

    // State the host still holds (a hot reload) wins over the saved copy.
    if (held.seq === 0) {
      const saved = await $.store.get(`trail:${id}`)

      if (isTrail(saved)) {
        held = await update($, trail, () => saved)
      }
    }

    // A fresh load has told the model nothing yet.
    lastTold = null

    // A tree saved by an earlier version may still plan steps under a task that was given up.
    held = await update($, trail, tidy)
    hasTrail = held.cursor !== null

    // Read back from the store: a new process, in which no job of the old one runs any more.
    let isNewProcess = false

    if ((await read($, work)).length === 0) {
      const saved = await $.store.get(`work:${id}`)

      if (Array.isArray(saved)) {
        await update($, work, () => saved as TrailWork[])
        isNewProcess = true
      }
    }

    await reconcile($, isNewProcess)

    if (hasTrail) {
      await wake($)

      // A restart or a reload may bring newer rules: the next prompt carries them with the tree, once per version.
      if ((await $.store.get(`rules:${id}`)) !== RULES) {
        isFullDue = true
        await $.store.set(`rules:${id}`, RULES)
      }
    }

    return next(e)
  })

  // The pane closed, by the person's mark or otherwise: the tree is the band's again.
  on('ui.close', ($, e, next) => {
    if (e.id === PANE) {
      isPaneDocked = false
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      carried = await read($, trail)
    }

    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await adopt($)
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isWorking = true
    justLeft = null

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isWorking = false

      // The end of a turn is when the pane looks again at what it still calls running.
      if (hasTrail) {
        await reconcile($, false)
      }
    } else if (hasTrail) {
      const state: TrailWorkState =
        e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      const agentId = e.agentId

      // A teammate that answered waits for its next message; it is not finished.
      await ended(
        $,
        agentId,
        item => (item.kind === 'teammate' && state === 'done' ? 'idle' : state),
        await $.clock.now(),
      )

      await orphan($, agentId)
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (!hasTrail) {
      return next(e)
    }

    const nodeId = (await read($, trail)).cursor
    const spawned = await next(e)

    if (spawned.deny === undefined && spawned.agentId !== undefined) {
      await started($, {
        id: spawned.agentId,
        kind: e.fork ? 'fork' : e.isTeammate === true ? 'teammate' : 'agent',
        title: `${e.subagentType}: ${e.description}`,
        nodeId,
        parentId: e.parentAgentId ?? null,
        state: 'running',
        startedAt: await $.clock.now(),
        endedAt: null,
      })
    }

    return spawned
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    const isInstalled =
      e.agentId === undefined &&
      e.trigger !== 'precompute' &&
      compacted.skip === undefined

    if (isInstalled && hasTrail) {
      isFullDue = true
    }

    return compacted
  })

  on('prompt.submit', async ($, e, next) => {
    const isPerson =
      e.origin.kind === 'composer' ||
      e.origin.kind === 'bridge' ||
      e.origin.kind === 'sdk'

    // Off, and no trail carried over a /clear: the mod has nothing to add.
    if (!hasTrail && carried === null) {
      return next(e)
    }

    // A background task says how it ended; anything else it says changes nothing.
    if (e.origin.kind === 'task-notification') {
      // One notice can name several tasks (the ones an earlier process left); the engine's own markers are not tasks.
      const ids = [...e.text.matchAll(/<task-id>([^<]+)<\/task-id>/g)]
        .map(match => (match[1] ?? '').trim())
        .filter(id => id !== '' && !id.startsWith('__'))
      const status = (/<status>([^<]+)<\/status>/.exec(e.text)?.[1] ?? '').trim()
      // A Monitor sends no status: its events keep it going, and its end is the one event that says it expired.
      const state: TrailWorkState | undefined = Object.hasOwn(ENDED, status)
        ? ENDED[status]
        : /<event>\s*\[Monitor expired/.test(e.text)
          ? 'done'
          : undefined

      if (state !== undefined) {
        const now = await $.clock.now()

        for (const id of ids) {
          await ended($, id, () => state, now)
        }
      }
    }

    if (!isPerson) {
      return next(e)
    }

    await adopt($)

    if (!hasTrail) {
      return next(e)
    }

    // Not through `change`: a prompt is no update of the trail.
    const held = await check($, await update($, trail, prompted))
    const owed = claim()

    await save($)

    // The note rides a prompt only when it says something new: the path or what is left open
    // changed, or the trail has gone unreported for a while. Said again it would only cost.
    const note = noteText(held)
    const told = [
      pathText(held),
      ...note.split('\n').filter(line => line.startsWith('Left open') || line.startsWith('Decisions waiting')),
    ].join('\n')
    const isStale =
      held.promptsSinceUpdate === STALE_AFTER ||
      (held.promptsSinceUpdate > STALE_AFTER && held.promptsSinceUpdate % 5 === 0)
    const isNews = told !== lastTold || isStale
    const sent = await next({
      ...e,
      context: [...(e.context ?? []), ...(isNews ? [note] : []), ...notesOf(held, owed)],
    })

    // A prompt that did not enter took no note with it: the notes stay owed.
    if (sent.drop !== undefined) {
      alarm = alarm ?? owed.alarm
      isFullDue = isFullDue || owed.isFull
    } else if (isNews) {
      lastTold = told
    }

    return sent
  })

  // Every main-loop tool result is a chance to hand the model a note it is owed.
  on('tool.call', async ($, e, next) => {
    if (!hasTrail) {
      return next(e)
    }

    // The node the call started under, read before it runs: the work may have moved on when it returns.
    const kind = Object.hasOwn(BACKGROUND, e.tool) ? BACKGROUND[e.tool] : undefined
    const nodeId = kind === undefined ? null : (await read($, trail)).cursor
    const ran = await next(e)

    // Turned off while the call ran.
    if (!hasTrail) {
      return ran
    }

    // A job stopped by hand sends no notification: its end is heard here.
    if (e.tool === 'TaskStop' && ran.deny === undefined && ran.isError !== true) {
      const stopped = (ran.result as { task_id?: unknown } | null)?.task_id ?? e.task_id ?? e.shell_id

      if (typeof stopped === 'string') {
        await ended($, stopped, () => 'stopped', await $.clock.now())
      }
    }

    if (kind !== undefined && ran.deny === undefined && ran.isError !== true) {
      const record = ran.result as { backgroundTaskId?: unknown; taskId?: unknown } | null
      const given = e as unknown as Record<string, unknown>
      const id = record?.backgroundTaskId ?? record?.taskId

      if (typeof id === 'string') {
        await started($, {
          id,
          kind,
          title: String(given.description ?? given.command ?? given.name ?? e.tool).slice(0, 120),
          nodeId,
          parentId: e.agentId ?? null,
          state: 'running',
          startedAt: await $.clock.now(),
          endedAt: null,
        })
      }
    }

    if (
      e.agentId !== undefined ||
      e.tool === TOOL ||
      ran.deny !== undefined
    ) {
      return ran
    }

    calls += 1

    // Counted and claimed before anything is awaited: results that finish together do not share a reminder.
    const counted = calls >= UNCONFIRMED_AFTER ? calls : 0

    if (counted > 0) {
      calls = 0
    }

    if (alarm === null && !isFullDue && counted === 0) {
      return ran
    }

    const owed = claim()
    const held = await read($, trail)
    const notes = [
      ...notesOf(held, owed),
      ...(counted > 0 ? [unconfirmedText(held, counted)] : []),
    ]

    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  })

  on('tool.call', { tool: 'mcp__trail__track' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'trail: only the main conversation keeps the trail.' }
    }

    await adopt($)

    const action = String(e.action)
    const title = typeof e.title === 'string' ? e.title.trim() : ''
    const kind = e.kind === 'step' || e.kind === 'detour' ? e.kind : null
    const now = await $.clock.now()

    if (!hasTrail) {
      return { deny: 'trail: the trail is off. The person turns it on with /trail; do not start one yourself.' }
    }

    // park and unpark take one name in "title", several in "titles"; "decide" holds the forks
    // that wait for the person's word, said outright rather than read from the wording.
    const listed = (Array.isArray(e.titles) ? e.titles.map(String) : [])
      .map(one => one.trim())
      .filter(one => one !== '')
    const asks = (Array.isArray(e.decide) ? e.decide.map(String) : [])
      .map(one => one.trim())
      .filter(one => one !== '')
    const named = [...(title === '' ? [] : [title]), ...listed]
    // The node a leave or a next closes: what it settled or left behind is said in the same call.
    const before = await read($, trail)
    const closing = before.cursor

    // "settled": waiting forks this call closes, by id, in the same change as the rest of it.
    if (e.settled !== undefined && !(Array.isArray(e.settled) && e.settled.every(one => typeof one === 'string'))) {
      return { deny: 'trail: "settled" takes a list of fork ids.' }
    }

    const settledIds = [
      ...new Set((Array.isArray(e.settled) ? (e.settled as string[]) : []).map(one => one.trim()).filter(one => one !== '')),
    ]

    if (settledIds.length > 0 && !['park', 'leave', 'next'].includes(action)) {
      return { deny: 'trail: "settled" goes with park, leave or next.' }
    }

    // Only a fork that waits now can be settled; an id that names none is skipped and said so.
    const settling = settledIds.flatMap(id => {
      const item = before.parked.find(one => one.isOpen && one.id === id)

      return item === undefined ? [] : [item]
    })
    const skipped = settledIds.filter(id => !settling.some(item => item.id === id))
    const filing = [...named, ...asks, ...(action === 'next' ? [title] : [])]
    const clash = settling.find(item => filing.some(one => parkedOf(before, one)?.id === item.id))

    if (clash !== undefined) {
      return { deny: `trail: «${clash.id}» is both settled and filed in this call; do one or the other.` }
    }

    const settleAll = (held: Trail): Trail => settling.reduce((kept, item) => unpark(kept, item.id), held)
    const under = typeof e.under === 'string' ? e.under.trim() : ''
    const rootId = before.nodes.find(node => node.parentId === null)?.id ?? null
    // enter, next: a new node goes where "under" says, "session" or a task not finished; anywhere else is no place.
    const placeId =
      under === '' ? null : under.toLowerCase() === 'session' ? rootId : before.nodes.find(node => node.id === under)?.id ?? null
    const placeState = placeId === null ? undefined : before.nodes.find(node => node.id === placeId)?.state

    if (['enter', 'next'].includes(action) && under !== '' && (placeId === null || placeState === 'done' || placeState === 'dropped')) {
      return { deny: `trail: no open task «${under}» to put this under. Use an id from action "show", or "session".` }
    }

    // What an enter or a next will land on, checked before anything changes: more than one node is no target.
    const aimed = (held: Trail, known: 'step' | 'detour'): { deny: string } | null => {
      const found = resolveTarget(held, title, known)

      if ('ambiguous' in found) {
        return {
          deny: `trail: «${title}» names ${found.ambiguous.length} open nodes: ${found.ambiguous.map(node => `[${node.id}] under ${node.parentId ?? 'the root'}`).join(', ')}. Enter one by its id.`,
        }
      }

      if ('node' in found && under !== '' && found.node.parentId !== placeId) {
        return { deny: `trail: «${found.node.id}» already has its place; enter it without "under".` }
      }

      return null
    }

    if (['goal', 'enter', 'next'].includes(action) && title === '') {
      return { deny: `trail: action "${action}" needs a title.` }
    }

    if (action === 'leave' && pathOf(await read($, trail)).length === 1) {
      return { deny: 'trail: no task is open, so there is nothing to leave. The session itself ends when the person types /trail off.' }
    }

    let held: Trail

    switch (action) {
      case 'goal':
        held = await change($, one => setGoal(one, title, now))
        break
      case 'plan': {
        const steps = Array.isArray(e.steps) ? e.steps.map(String) : []

        held = await change($, one => addSteps(one, steps))
        break
      }
      case 'enter': {
        // Only a new node needs its kind said; going back to one that exists does not.
        const known = kind ?? kindOf(before, title)

        if (known === null) {
          return { deny: 'trail: action "enter" needs kind "step" or "detour" for a new node.' }
        }

        const refused = aimed(before, known)

        if (refused !== null) {
          return refused
        }

        held = await change($, one => enter(one, title, known, now, under === '' ? null : under))
        break
      }
      case 'next': {
        const outcome = typeof e.outcome === 'string' && e.outcome.trim() !== '' ? e.outcome : null
        const as = e.as === 'done' || e.as === 'dropped' || e.as === 'open' ? e.as : undefined
        // The target is resolved on the tree as it stands after the leave, and nothing is committed if that fails.
        const how = (as ?? 'done') === 'done' && outcome === null ? 'open' : (as ?? 'done')
        const here = before.nodes.find(node => node.id === before.cursor)
        const after = here === undefined || here.parentId === null ? settleAll(before) : leave(settleAll(before), how, outcome, now)
        const refused = aimed(after, kind ?? 'step')

        if (refused !== null) {
          return refused
        }

        held = await change($, one =>
          withForks(
            advance(settleAll(one), title, kind ?? 'step', outcome, now, as, under === '' ? null : under),
            closing,
            listed,
            asks,
            now,
          ),
        )
        break
      }
      case 'leave': {
        const as = e.as === 'dropped' || e.as === 'open' ? e.as : 'done'
        const outcome = typeof e.outcome === 'string' ? e.outcome : null

        held = await change($, one => withForks(leave(settleAll(one), as, outcome, now), closing, listed, asks, now))
        justLeft = closing
        break
      }
      case 'park': {
        if (named.length === 0 && asks.length === 0) {
          return { deny: 'trail: action "park" needs a title.' }
        }

        const at = await read($, trail)
        // Said where it belongs: there. Otherwise under the task at hand, or the one left in this turn.
        const place =
          under === ''
            ? pathOf(at).length === 1 && justLeft !== null
              ? justLeft
              : undefined
            : under.toLowerCase() === 'session'
              ? pathOf(at)[0]?.id
              : at.nodes.find(node => node.id === under)?.id

        if (under !== '' && place === undefined) {
          return { deny: `trail: no task «${under}» to park under. Use an id from action "show", or "session".` }
        }

        held = await change($, one => {
          const filed = (kept: Trail, fork: string, isDecision: boolean): Trail => {
            if (parkedOf(kept, fork) === undefined) {
              return park(kept, fork, now, place, isDecision ? true : undefined)
            }

            const moved = place !== undefined && under !== '' ? moveFork(kept, fork, place) : kept

            return isDecision ? markAsk(moved, fork) : moved
          }

          return asks.reduce(
            (kept, fork) => filed(kept, fork, true),
            named.reduce((kept, fork) => filed(kept, fork, false), settleAll(one)),
          )
        })
        break
      }
      case 'unpark': {
        const before = await read($, trail)

        if (!named.some(one => parkedOf(before, one) !== undefined)) {
          return { deny: `trail: no parked item «${named.join(', ')}» is waiting.` }
        }

        held = await change($, one => named.reduce(unpark, one))
        break
      }
      case 'confirm':
        held = await change($, confirm)
        break
      case 'show':
        // Read only: the person asked what is open, or named something by its id.
        // What is open, with every id; the finished branches too only when asked for "all".
        return { result: treeText(await read($, trail), title.toLowerCase() !== 'all') }
      case 'fix':
        held = await change($, one => fix(one, title === '' ? null : title, kind))
        break
      default:
        return { deny: `trail: unknown action "${action}".` }
    }

    held = await check($, held)

    const lines = [`${pathText(held)} (${statsText(held)})`]

    if (action === 'plan' || action === 'goal') {
      lines.push(treeText(held))
    }

    // Short on purpose: every word of a result stays in the conversation and is read again with each request.
    // A task that was being worked on and is now left open by this call is named: it is continued by id, or closed.
    if (action === 'enter' || action === 'next') {
      const wasActive = new Set(before.nodes.filter(node => node.state === 'active').map(node => node.id))
      const leftOpen = held.nodes.filter(node => node.state === 'open' && node.startedAt !== null && wasActive.has(node.id))

      if (leftOpen.length > 0) {
        lines.push(
          `Left open: ${leftOpen.map(node => `[${node.id}] ${node.title}`).join('; ')}. Continue it by id, or close it with "leave" after entering it.`,
        )
      }
    }

    if (settling.length > 0) {
      lines.push(`Settled: ${settling.map(item => `[${item.id}] ${item.title}`).join('; ')}`)
    }

    if (skipped.length > 0) {
      lines.push(`Not waiting, skipped: ${skipped.join(', ')}`)
    }

    // A new decision is the moment to settle the old one it replaces: the others waiting are named, with their ids.
    if (asks.length > 0 && ['park', 'leave', 'next'].includes(action)) {
      const justFiled = new Set(asks.map(one => parkedOf(held, one)?.id))
      const waiting = decisionsText({ ...held, parked: held.parked.filter(item => !justFiled.has(item.id)) })

      if (waiting !== '') {
        lines.push(waiting)
      }
    }

    if (action === 'park') {
      const touched = new Set([...named, ...asks].map(one => parkedOf(held, one)?.id))

      lines.push(`Parked: ${forksText(held, item => touched.has(item.id))}`)
    } else if (action === 'leave' || action === 'next') {
      // A task ending is the moment to close what it settled: its own forks are named, the rest counted.
      const own = forksText(held, item => item.fromId === closing)
      const others = held.parked.filter(item => item.isOpen && item.fromId !== closing).length

      if (own !== '') {
        lines.push(`Open under what you left, unpark what it settled: ${own}`)
      }

      if (others > 0) {
        lines.push(`${others} other ${others === 1 ? 'fork' : 'forks'} open; action "show" lists them.`)
      }
    }

    return { result: [...lines, ...notesOf(held, claim())].join('\n') }
  })

  on('command.run', { command: 'trail' }, async ($, e) => {
    await adopt($)


    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const text = rest.join(' ')
    const now = await $.clock.now()

    if (verb === 'off') {
      await change($, () => EMPTY)
      await forget($)
      await save($)
      halt()
      await $.ui.close({ id: PANE })

      return { text: 'Trail off.' }
    }

    // Turning it on is all the person does: the session is the root, Claude files the tasks under it.
    if (!hasTrail && (verb === '' || (verb === 'goal' && text !== ''))) {
      const root = verb === 'goal' ? text : ROOT

      await wake($)
      await change($, one => setGoal(one, root, now))
      await $.store.set(`rules:${await $.session.id()}`, RULES)

      return {
        text: 'Trail on.',
        context: [
          `${USAGE}\n\nThe person just turned the trail on. If a task is under way, enter it the next time you act on it; otherwise enter the next one as it starts. Open items that were already standing before now (decisions waiting, things left undone) belong to the session: park them with "under": "session", not under the first task. Do not answer this note.`,
        ],
      }
    }

    if (!hasTrail) {
      return { text: `The trail is off. ${COMMAND_HELP}` }
    }

    if (verb === 'goal' && text !== '') {
      const held = await change($, one => setGoal(one, text, now))

      return { text: `Trail: the session is named «${pathOf(held)[0]?.title ?? text}».` }
    }

    if (verb === 'clear') {
      // Still on: the tree starts over from an empty session.
      await change($, () => setGoal(EMPTY, ROOT, now))
      await forget($)
      await save($)

      return { text: 'Trail cleared.' }
    }

    if (verb === 'close') {
      isPaneDocked = false
      await $.ui.close({ id: PANE })
      $.ui.invalidate('ui.render')

      return { text: 'Trail pane closed. The tree stands above the prompt.' }
    }

    if (verb === 'pane') {
      const placed = await openPane($)

      return {
        text: placed.isPlaced
          ? 'Trail pane opened; /trail close takes it away again.'
          : 'Trail: no pane can be placed here; the tree stands above the prompt.',
      }
    }

    if (verb === '') {
      return {
        text: 'Trail is on. The tree stands above the prompt; its [-] (ctrl+x ctrl+a) folds it and shows it again. /trail pane opens it as a pane of its own.',
      }
    }

    const isView = verb === '' || verb === 'text'
    const held = await read($, trail)

    if (verb === 'unpark' && text !== '') {
      const item = parkedOf(held, text)

      if (item === undefined) {
        return { text: `Trail: no parked item «${text}» is waiting.` }
      }

      await change($, one => unpark(one, text))

      return { text: `Trail: «${item.title}» is no longer parked.` }
    }

    if (isView) {
      return { text: `${treeText(held)}\n${statsText(held)}` }
    }

    if (verb === 'park' && text !== '') {
      await change($, one => park(one, text, now))

      return { text: `Trail: parked «${text}».` }
    }

    const ending = Object.hasOwn(ENDINGS, verb) ? ENDINGS[verb] : undefined

    if (ending !== undefined) {
      const here = pathOf(held).at(-1)

      if (here === undefined || here.parentId === null) {
        return { text: 'Trail: no task is open; /trail off turns the trail off.' }
      }

      const outcome = text === '' ? null : text
      const after = await change($, one => leave(one, ending.as, outcome, now))

      return {
        text: `Trail: «${here.title}» ${ending.says}; the work is back on ${pathText(after)}.`,
      }
    }

    return { text: COMMAND_HELP }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, trail)

    screenRows = e.viewport?.rows ?? screenRows

    if (e.props.hasSurvey || held.cursor === null) {
      return next(e)
    }

    const jobs = await read($, work)
    const counts = countsText(held, runningOf(jobs))
    const detour = depthOf(held) > 0 ? `in a detour, ${held.detourMinutes} working min` : ''
    const stats = [counts, detour].filter(part => part !== '').join(' · ')
    const { Box, Button, Text } = $.ui.resolve(e)
    const line =
      stats === '' ? null : held.isTripped ? (
        <Text color="warning" wrap="truncate-end">
          {stats}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {stats}
        </Text>
      )

    // Beside the docked pane the band is the one line of counts; the tree is in the pane.
    if (isPaneDocked) {
      return line ?? next(e)
    }

    // The band is the tree, in a frame of its own, folded and shown again with the engine's [-].
    // The engine keeps five cells at the right end of the band's first row for that mark; the
    // title row stands there, so the frame under it can take the whole width of the terminal.
    const wide = e.surface === 'terminal' ? e.props.bodyColumns + 5 : undefined
    // The frame and its padding take two cells on either side.
    const width = Math.max(20, (wide ?? e.props.bodyColumns) - 4)
    const now = await $.clock.now()
    const pressed = await read($, opened)
    const all = paneRows(held, jobs, now, width, pressed, await read($, unfolded), true)
    const room = roomOf()
    const current = await read($, page)
    const isWhole = all.length <= room
    const nav: ReturnType<typeof Button>[] = []
    let shown: PaneRow[]

    // The whole tree when it fits. Otherwise the strip, and from it the whole tree in pages of a fixed
    // height, so that the box never grows past the band and the engine never scrolls it: no row jumps,
    // the title stays where it is.
    if (isWhole) {
      shown = all
    } else if (current === 0) {
      const strip = stripRows(held, jobs, now, width, room - 1, pressed)

      shown = strip.rows
      nav.push(
        <Button
          plain
          dimColor
          key="more"
          label={`▾ ${strip.hidden === '' ? 'the whole tree' : strip.hidden}`}
          onPress={() => update($, page, () => 1)}
        />,
      )
    } else {
      // Opened, the box takes what the band allows (the title, the page and this row inside it), a sixth of the screen at least.
      const per = Math.max(room, e.props.maxRows - 2) - 1
      const pages = Math.max(1, Math.ceil(all.length / per))
      const at = Math.min(current, pages)

      shown = all.slice((at - 1) * per, at * per)
      nav.push(<Button plain dimColor key="fewer" label="▴ show fewer" onPress={() => update($, page, () => 0)} />)

      if (at > 1) {
        nav.push(<Button plain dimColor key="back" label="◂ back" onPress={() => update($, page, () => at - 1)} />)
      }

      if (at < pages) {
        nav.push(
          <Button plain dimColor key="next" label={`more ▸ ${at}/${pages}`} onPress={() => update($, page, () => at + 1)} />,
        )
      }
    }

    const body = [
      ...drawRows($, e, shown),
      ...(nav.length === 0
        ? []
        : [
            <Box columnGap={2}>
              {nav}
            </Box>,
          ]),
    ]

    // Elsewhere than on the terminal the surface draws the frame, with the title as its first row.
    if (wide === undefined) {
      const title = (
        <Box justifyContent="space-between" columnGap={2}>
          <Text bold color="suggestion">
            Trail
          </Text>
          {line}
        </Box>
      )

      return (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {title}
          {body}
        </Box>
      )
    }

    // On the terminal the frame is drawn by hand, so that its top edge can carry the title and the
    // counts and end where the engine's [-] stands: a title bar with its toggle at the right end.
    const head = '╭─ '
    const said = stats.slice(0, Math.max(0, e.props.bodyColumns - head.length - 'Trail'.length - 6))
    const rule = '─'.repeat(
      Math.max(1, e.props.bodyColumns - head.length - 'Trail'.length - said.length - (said === '' ? 1 : 2)),
    )
    const title = (
      <Box>
        <Text dimColor>{head}</Text>
        <Text bold color="suggestion">
          Trail
        </Text>
        <Text dimColor>{` ${rule}${said === '' ? '' : ' '}`}</Text>
        {held.isTripped ? <Text color="warning">{said}</Text> : <Text dimColor>{said}</Text>}
      </Box>
    )
    const sided = (row: (typeof body)[number]) => (
      <Box width={wide}>
        <Text dimColor>{'│ '}</Text>
        <Box flexGrow={1}>{row}</Box>
        <Text dimColor>{' │'}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {title}
        {body.map(sided)}
        <Box width={wide}>
          <Text dimColor>{`╰${'─'.repeat(wide - 2)}╯`}</Text>
        </Box>
      </Box>
    )
  })

  // A trail call draws nothing in the conversation: the pane is where it shows. A refused one keeps its row.
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__trail__track' } }, ($, e, next) => {
    if (e.props.isErrored || e.props.isInterrupted) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__trail__track' } }, ($, e, next) => {
    if (e.props.isErrored) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  // The side window of the fullscreen layout: the trail as a tree, with the parallel work under the node it started from.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    screenRows = e.viewport?.rows ?? screenRows

    // Only a docked pane takes the tree over from the band; one seated above the prompt stands beside it.
    isPaneDocked = e.props.placement === 'dock'

    const { Box } = $.ui.resolve(e)
    const rows = paneRows(
      await read($, trail),
      await read($, work),
      await $.clock.now(),
      e.props.bodyColumns,
      await read($, opened),
      await read($, unfolded),
      e.props.placement === 'inline',
    )

    return <Box flexDirection="column">{drawRows($, e, rows)}</Box>
  })
}
