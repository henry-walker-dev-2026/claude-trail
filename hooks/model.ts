import type { Trail, TrailKind, TrailNode, TrailParked, TrailWork } from '../types'

export type Limits = { depth: number; minutes: number; prompts: number }

export const TOOL = 'mcp__trail__track'

/** The person's prompts without a trail update after which the note asks. */
export const STALE_AFTER = 3

/** Outcomes are one line; longer text is cut. */
const LINE = 200

/** How many nodes left open the note names. */
const LOOSE_NAMED = 6

/** Titles are short enough to read in a narrow pane; longer ones are cut. */
const TITLE = 80

export const EMPTY: Trail = {
  nodes: [],
  cursor: null,
  parked: [],
  seq: 0,
  detourMinutes: 0,
  detourPrompts: 0,
  promptsSinceUpdate: 0,
  isTripped: false,
}

const clip = (text: string, most = LINE) =>
  text.trim().replace(/\s+/g, ' ').slice(0, most)

const clipTitle = (title: string) => clip(title, TITLE)

const fold = (title: string) => clipTitle(title).toLowerCase()

const nodeOf = (trail: Trail, id: string | null) =>
  id === null ? undefined : trail.nodes.find(node => node.id === id)

const isLooseEnd = (node: TrailNode) =>
  node.state === 'open' && node.startedAt !== null

/** The waiting parked item `target` names, by its id or its title. */
export const parkedOf = (trail: Trail, target: string) =>
  trail.parked.find(
    item =>
      item.isOpen &&
      (item.id === target.trim() || fold(item.title) === fold(target)),
  )

const closeParked = (trail: Trail, id: string): Trail => ({
  ...trail,
  parked: trail.parked.map(item =>
    item.id === id ? { ...item, isOpen: false } : item,
  ),
})

/** The nodes from the goal down to the cursor. */
export const pathOf = (trail: Trail): TrailNode[] => {
  const path: TrailNode[] = []

  for (
    let node = nodeOf(trail, trail.cursor);
    node !== undefined;
    node = nodeOf(trail, node.parentId)
  ) {
    path.unshift(node)
  }

  return path
}

/** The node the work left for its detours: the one before the first detour on the path. */
export const mainOf = (trail: Trail): TrailNode | undefined => {
  const path = pathOf(trail)
  const first = path.findIndex(node => node.kind === 'detour')

  return first < 0 ? path.at(-1) : path[first - 1]
}

/** How many detours the cursor sits inside: a step under a detour is still off the main line. */
export const depthOf = (trail: Trail) =>
  pathOf(trail).filter(node => node.kind === 'detour').length

/**
 * Every change of the trail ends here: it counts as an update, and back on
 * the main line the detour counters and the tripwire start over.
 */
const settle = (trail: Trail): Trail =>
  depthOf(trail) === 0
    ? {
        ...trail,
        detourMinutes: 0,
        detourPrompts: 0,
        isTripped: false,
        promptsSinceUpdate: 0,
      }
    : { ...trail, promptsSinceUpdate: 0 }

/** Moves the cursor: its path becomes active, what was active elsewhere is left open. */
const moveTo = (trail: Trail, cursor: string, now: number): Trail => {
  const onPath = new Set(pathOf({ ...trail, cursor }).map(node => node.id))
  const nodes = trail.nodes.map((node): TrailNode => {
    if (onPath.has(node.id)) {
      return {
        ...node,
        state: 'active',
        startedAt: node.startedAt ?? now,
        endedAt: null,
      }
    }

    return node.state === 'active' ? { ...node, state: 'open' } : node
  })

  return settle({ ...trail, nodes, cursor })
}

const add = (
  trail: Trail,
  kind: TrailKind,
  title: string,
  parentId: string | null,
): Trail => {
  const node: TrailNode = {
    id: `n${trail.seq + 1}`,
    kind,
    title: clipTitle(title),
    state: 'open',
    parentId,
    startedAt: null,
    endedAt: null,
    outcome: null,
  }

  return { ...trail, seq: trail.seq + 1, nodes: [...trail.nodes, node] }
}

/** Retitles the goal of a running trail; with none running, starts a new trail that keeps the open parked items. */
export const setGoal = (trail: Trail, title: string, now: number): Trail => {
  const root = pathOf(trail)[0]

  if (root !== undefined) {
    const nodes = trail.nodes.map(node =>
      node.id === root.id ? { ...node, title: clipTitle(title) } : node,
    )

    return settle({ ...trail, nodes })
  }

  const parked = trail.parked
    .filter(item => item.isOpen)
    .map(item => ({ ...item, fromId: null }))
  const fresh = add({ ...EMPTY, seq: trail.seq, parked }, 'goal', title, null)

  return moveTo(fresh, `n${fresh.seq}`, now)
}

/** Adds the planned steps of what is being worked on (the root, or the task the cursor is in) that are not there yet. */
export const addSteps = (trail: Trail, titles: readonly string[]): Trail => {
  const base = pathOf(trail)
    .filter(node => node.kind !== 'detour')
    .at(-1)

  if (base === undefined) {
    return trail
  }

  const known = new Set(
    trail.nodes
      .filter(node => node.parentId === base.id)
      .map(node => fold(node.title)),
  )
  let next = trail

  for (const title of titles) {
    if (clipTitle(title) !== '' && !known.has(fold(title))) {
      known.add(fold(title))
      next = add(next, 'step', title, base.id)
    }
  }

  return settle(next)
}

/** The kind of what `target` names, a node by id or open title, or a parked fork: going back to it needs no kind said. */
export const kindOf = (trail: Trail, target: string): 'step' | 'detour' | null => {
  const node =
    nodeOf(trail, target.trim()) ??
    trail.nodes.find(one => one.state === 'open' && fold(one.title) === fold(target))

  if (node === undefined) {
    return parkedOf(trail, target) === undefined ? null : 'step'
  }

  return node.kind === 'detour' ? 'detour' : 'step'
}

/**
 * Moves to the node `target` names by id, or by the title of a planned step
 * or a loose end of that kind; otherwise opens a new node under the cursor.
 */
export const enter = (
  trail: Trail,
  target: string,
  kind: 'step' | 'detour',
  now: number,
): Trail => {
  if (trail.cursor === null) {
    return trail
  }

  const named = trail.nodes.filter(
    node =>
      node.kind === kind &&
      node.state === 'open' &&
      fold(node.title) === fold(target),
  )
  const path = new Set(pathOf(trail).map(node => node.id))
  const waiting =
    nodeOf(trail, target.trim()) ??
    named.find(node => node.parentId === trail.cursor) ??
    named.find(node => node.parentId !== null && path.has(node.parentId)) ??
    named[0]

  if (waiting !== undefined) {
    return moveTo(trail, waiting.id, now)
  }

  // A parked item picked up becomes the node, and stops waiting.
  const picked = parkedOf(trail, target)
  const from = picked === undefined ? trail : closeParked(trail, picked.id)
  const next = add(from, kind, picked?.title ?? target, trail.cursor)

  return moveTo(next, `n${next.seq}`, now)
}

/**
 * The work moves on: leaves the cursor's node, unless it is the root, and
 * enters `target`. A node left without an outcome is never done, whatever the
 * caller says: it stays open, so that moving on never hides unfinished work.
 */
export const advance = (
  trail: Trail,
  target: string,
  kind: 'step' | 'detour',
  outcome: string | null,
  now: number,
  state: 'done' | 'dropped' | 'open' = 'done',
): Trail => {
  const here = nodeOf(trail, trail.cursor)
  const how = state === 'done' && outcome === null ? 'open' : state
  const left =
    here === undefined || here.parentId === null
      ? trail
      : leave(trail, how, outcome, now)
  const entered = enter(left, target, kind, now)

  // Leaving a detour for another detour touches the main line only on paper: the counters and the tripwire keep running.
  if (depthOf(trail) > 0 && depthOf(entered) > 0) {
    return {
      ...entered,
      detourMinutes: trail.detourMinutes,
      detourPrompts: trail.detourPrompts,
      isTripped: trail.isTripped,
    }
  }

  return entered
}


/** A planned step never started under a branch that was given up is given up with it. */
export const tidy = (trail: Trail): Trail => {
  const byId = new Map(trail.nodes.map(node => [node.id, node]))
  const isGivenUp = (node: TrailNode): boolean => {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId)

    return parent !== undefined && (parent.state === 'dropped' || isGivenUp(parent))
  }
  const nodes = trail.nodes.map((node): TrailNode =>
    node.state === 'open' && node.startedAt === null && isGivenUp(node)
      ? { ...node, state: 'dropped' }
      : node,
  )

  return nodes.some((node, index) => node !== trail.nodes[index]) ? { ...trail, nodes } : trail
}

/** Closes the cursor's node and returns to its parent; `open` leaves it as a loose end to pick up later. */
export const leave = (
  trail: Trail,
  state: 'done' | 'dropped' | 'open',
  outcome: string | null,
  now: number,
): Trail => {
  const here = nodeOf(trail, trail.cursor)

  if (here === undefined) {
    return trail
  }

  const left: TrailNode = {
    ...here,
    state,
    outcome: outcome === null ? null : clip(outcome),
    endedAt: state === 'open' ? null : now,
  }
  const nodes = trail.nodes.map(node => (node.id === here.id ? left : node))

  return settle(tidy({ ...trail, nodes, cursor: here.parentId }))
}

export const park = (
  trail: Trail,
  title: string,
  now: number,
  fromId: string | null = trail.cursor,
  isAsk?: boolean,
): Trail =>
  // A fork already waiting under that title is not listed twice.
  parkedOf(trail, title) !== undefined
    ? trail
    : settle({
        ...trail,
        seq: trail.seq + 1,
        parked: [
          ...trail.parked,
          {
            id: `p${trail.seq + 1}`,
            title: clipTitle(title),
            fromId,
            at: now,
            isOpen: true,
            ...(isAsk !== undefined && { isAsk }),
          },
        ],
      })

/** Says of a waiting fork that it waits for the person's word. */
export const markAsk = (trail: Trail, target: string): Trail => {
  const item = parkedOf(trail, target)

  return item === undefined
    ? trail
    : settle({
        ...trail,
        parked: trail.parked.map(one => (one.id === item.id ? { ...one, isAsk: true } : one)),
      })
}

/**
 * Whether a fork waits for the person's word. Said outright when it was
 * parked; a fork noted before that was possible is read by its wording.
 */
export const isAsk = (item: TrailParked): boolean =>
  item.isAsk ?? (/^decide\b/i.test(item.title) || item.title.trim().endsWith('?'))

/** Takes a fork off the list by hand: a parked one stops waiting, a task left unfinished is given up. */
export const dropFork = (trail: Trail, id: string, now: number): Trail => {
  const node = nodeOf(trail, id)

  if (node === undefined || !isLooseEnd(node)) {
    return unpark(trail, id)
  }

  return settle(
    tidy({
      ...trail,
      nodes: trail.nodes.map((one): TrailNode =>
        one.id === id ? { ...one, state: 'dropped', endedAt: now } : one,
      ),
    }),
  )
}

/** The forks still waiting, with the ids they are picked up or closed by. */
export const forksText = (trail: Trail, only: (item: TrailParked) => boolean = () => true): string =>
  trail.parked
    .filter(item => item.isOpen && only(item))
    .map(item => `[${item.id}] ${item.title}${isAsk(item) ? ' (to decide)' : ''}`)
    .join('; ')

/** Hangs a waiting fork under another node: it was noted in one place and belongs in another. */
export const moveFork = (trail: Trail, target: string, fromId: string): Trail => {
  const item = parkedOf(trail, target)

  return item === undefined
    ? trail
    : settle({
        ...trail,
        parked: trail.parked.map(one => (one.id === item.id ? { ...one, fromId } : one)),
      })
}

/** A parked item is no longer waiting: it got done elsewhere, or is dropped. */
export const unpark = (trail: Trail, target: string): Trail => {
  const item = parkedOf(trail, target)

  return item === undefined ? trail : settle(closeParked(trail, item.id))
}

/** Corrects the cursor's node: its title, or whether it is a step or a detour. */
export const fix = (
  trail: Trail,
  title: string | null,
  kind: 'step' | 'detour' | null,
): Trail => {
  const nodes = trail.nodes.map((node): TrailNode => {
    if (node.id !== trail.cursor) {
      return node
    }

    return {
      ...node,
      title: title === null ? node.title : clipTitle(title),
      kind: kind === null || node.kind === 'goal' ? node.kind : kind,
    }
  })

  return settle({ ...trail, nodes })
}

/** The path is still right: counts as an update, changes nothing else. */
export const confirm = (trail: Trail): Trail => settle(trail)

/** One working minute passed. */
export const tick = (trail: Trail): Trail =>
  depthOf(trail) > 0
    ? { ...trail, detourMinutes: trail.detourMinutes + 1 }
    : trail

/** The person sent a prompt. */
export const prompted = (trail: Trail): Trail => ({
  ...trail,
  promptsSinceUpdate: trail.promptsSinceUpdate + 1,
  detourPrompts: depthOf(trail) > 0 ? trail.detourPrompts + 1 : 0,
})

/** Why the tripwire fires now, or null: it fires once, until the main line is touched again. */
export const tripOf = (trail: Trail, limits: Limits): string | null => {
  const depth = depthOf(trail)

  if (trail.isTripped || depth === 0) {
    return null
  }

  if (depth >= limits.depth) {
    return depth === 1
      ? 'the work has left the main line for a detour'
      : `detours are nested ${depth} deep`
  }

  if (trail.detourMinutes >= limits.minutes) {
    return `${trail.detourMinutes} working minutes have gone into detours`
  }

  if (trail.detourPrompts >= limits.prompts) {
    return `${trail.detourPrompts} of the person's prompts have gone into detours`
  }

  return null
}

export const pathText = (trail: Trail) =>
  pathOf(trail)
    .map(node => node.title)
    .join(' › ')

export const statsText = (trail: Trail): string => {
  const depth = depthOf(trail)
  const steps = trail.nodes.filter(
    node => node.kind === 'step' && node.state !== 'dropped',
  )
  const done = steps.filter(node => node.state === 'done').length
  const parked = trail.parked.filter(item => item.isOpen).length
  const loose = trail.nodes.filter(isLooseEnd).length
  const parts = [
    steps.length > 0 && `${done}/${steps.length} steps`,
    depth > 0 && `detour depth ${depth}`,
    depth > 0 && `${trail.detourMinutes} working min in detours`,
    parked > 0 && `${parked} parked`,
    loose > 0 && `${loose} left open`,
    trail.promptsSinceUpdate >= STALE_AFTER &&
      `not updated for ${trail.promptsSinceUpdate} prompts`,
  ].filter(part => part !== false)

  return parts.length > 0 ? parts.join(' · ') : 'on the main line'
}

const MARKS = { active: '▸', done: '✓', dropped: '✗' } as const

const markOf = (node: TrailNode) => {
  if (node.state === 'open') {
    return node.startedAt === null ? '○' : '◌'
  }

  return MARKS[node.state]
}

/** The whole trail as indented lines, each node with its id, then the open parked items. */
export const treeText = (trail: Trail, isOpenOnly = false): string => {
  const lines: string[] = []
  // A branch that is finished, with nothing unfinished under it.
  const isShut = (node: TrailNode): boolean =>
    (node.state === 'done' || node.state === 'dropped') &&
    trail.nodes.filter(one => one.parentId === node.id).every(isShut)
  let shut = 0
  const walk = (parentId: string | null, indent: string) => {
    for (const node of trail.nodes.filter(one => one.parentId === parentId)) {
      // Asked only for what is open, the finished branches are counted, not listed.
      if (isOpenOnly && isShut(node)) {
        shut += 1
        continue
      }

      const tail = [
        `[${node.id}]`,
        node.outcome !== null && `(${node.outcome})`,
        isLooseEnd(node) && '(left open)',
        node.id === trail.cursor && '← here',
      ].filter(part => part !== false)
      const label = node.kind === 'detour' ? `detour: ${node.title}` : node.title

      lines.push([`${indent}${markOf(node)} ${label}`, ...tail].join(' '))
      walk(node.id, `${indent}  `)
    }
  }

  walk(null, '')

  if (shut > 0) {
    lines.push(`(${shut} finished ${shut === 1 ? 'branch is' : 'branches are'} left out)`)
  }

  const parked = trail.parked.filter(item => item.isOpen)

  if (parked.length > 0) {
    lines.push('Parked:')

    for (const item of parked) {
      const from = nodeOf(trail, item.fromId)

      lines.push(
        from === undefined
          ? `  ${isAsk(item) ? '?' : '·'} ${item.title} [${item.id}]`
          : `  ${isAsk(item) ? '?' : '·'} ${item.title} [${item.id}] (from: ${from.title})`,
      )
    }
  }

  return lines.join('\n')
}

/** What the model reads beside each of the person's prompts while the trail is on: the path, then what was left open, then a nudge when the trail looks stale. */
export const noteText = (trail: Trail): string => {
  const loose = trail.nodes
    .filter(isLooseEnd)
    .slice(-LOOSE_NAMED)
    .map(node => `[${node.id}] ${node.title}`)

  return [
    `[trail] ${pathText(trail)} (${statsText(trail)})`,
    loose.length > 0 && `Left open, continue by id: ${loose.join(', ')}`,
    trail.promptsSinceUpdate >= STALE_AFTER &&
      `The trail has not been updated for ${trail.promptsSinceUpdate} prompts. If the path above is wrong, correct it along with your next tool calls; if it is right, do nothing.`,
  ]
    .filter(line => line !== false)
    .join('\n')
}

/** What the model reads once when the tripwire fires. */
export const tripText = (trail: Trail, reason: string): string => {
  const main = mainOf(trail)

  return `[trail tripwire] ${reason}. Path: ${pathText(trail)}. Stop before going further and ask the person, in plain words and three sentences at most: say what you are doing now and that it is off «${main?.title ?? ''}», then ask whether to continue it, leave it for later, or drop it and go back. Do not mention the trail, the tripwire or this note.`
}

/** What the model reads once after a compaction: the whole trail. */
export const fullText = (trail: Trail): string =>
  `[trail] What is open in the trail as it stands:\n${treeText(trail, true)}`

/** What the model reads after many tool calls with no trail update. */
export const unconfirmedText = (trail: Trail, calls: number): string => {
  const here = nodeOf(trail, trail.cursor)?.title ?? ''

  return `[trail] ${calls} tool calls since the trail was last updated. Path: ${pathText(trail)}. If the work is still on «${here}», do nothing; if it has moved on, say so along with your next tool calls.`
}

/** The forks at the left edge that share what the person has to do with them. */
type Group = { heading: string; tone: 'ask' | 'note'; items: TrailParked[] }

export type PaneRow = {
  text: string
  /**
   * Set on the rows of an open fork: a press on one opens the fork up or
   * closes it. `at` is where its mark stands in `text`, after the tree's lines.
   */
  fork?: { id: string; title: string; line: number; at: number }
  /** Set on the one row under an opened fork that holds its actions; its `text` is the indent. */
  act?: { id: string; title: string }
  /** Set on the row that stands for a node's folded closed branches: a press shows or hides them. */
  fold?: { id: string; at: number }
  tone: 'head' | 'title' | 'here' | 'open' | 'warn' | 'ask' | 'note' | 'plain' | 'done' | 'run' | 'fail' | 'dim'
}


/** How many finished pieces of parallel work that hang under no node still show. */
const LOOSE_SHOWN = 3

/** The pane's width when the surface has not said. */
const WIDE = 200

/** The narrowest a wrapped label gets, however deep its row sits. */
const NARROWEST = 16

const WORK_MARKS = {
  running: '●',
  idle: '◌',
  done: '✓',
  failed: '✗',
  stopped: '✗',
  unknown: '?',
} as const

const span = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))

  if (minutes < 60) {
    return minutes < 1 ? 'under 1 min' : `${minutes} min`
  }

  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

/** Breaks a label between words so that no line is wider than `width`; a word wider than that keeps its line. */
const wrap = (text: string, width: number): string[] => {
  const lines: string[] = []
  let line = ''

  for (const word of text.split(' ')) {
    if (line === '') {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`
    } else {
      lines.push(line)
      line = word
    }
  }

  return [...lines, line]
}

export const runningOf = (work: readonly TrailWork[]) =>
  work.filter(item => item.state === 'running').length

const workLabel = (item: TrailWork, now: number): string => {
  const time = span((item.endedAt ?? now) - item.startedAt)
  const state =
    item.state === 'running'
      ? time
      : item.endedAt === null
        ? item.state
        : `${item.state} after ${time}`

  return `${item.kind} · ${item.title} · ${state}`
}

const workTone = (item: TrailWork): PaneRow['tone'] => {
  if (item.state === 'running') {
    return 'run'
  }

  return item.state === 'failed' || item.state === 'stopped' ? 'fail' : 'done'
}

const toneOf = (trail: Trail, node: TrailNode): PaneRow['tone'] => {
  if (node.id === trail.cursor) {
    return 'here'
  }

  if (node.state === 'active') {
    return node.kind === 'detour' ? 'warn' : 'open'
  }

  if (node.state === 'open') {
    return node.startedAt === null ? 'plain' : 'warn'
  }

  return node.state === 'done' ? 'done' : 'dim'
}

/** What is counted under the tree, in words; nothing that is zero. */
/**
 * What is still open, in words; nothing that is zero. What is done is not
 * counted: the person reads this line to see what is left, not what is behind.
 */
export const countsText = (trail: Trail, running: number): string => {
  const forks = trail.parked.filter(item => item.isOpen)
  const asks = forks.filter(isAsk).length
  const loose = trail.nodes.filter(isLooseEnd).length

  return [
    forks.length > 0 &&
      `${forks.length} ${forks.length === 1 ? 'fork' : 'forks'} open${asks > 0 ? `, ${asks} for you to decide` : ''}`,
    loose > 0 && `${loose} unfinished`,
    running > 0 && `${running} running`,
  ]
    .filter(part => part !== false)
    .join(' · ')
}

/**
 * The side pane's rows, made to be read at a glance: where the work is now,
 * how many tasks are done, then the trail as a tree: under each node the forks
 * raised in it that are still open and the parallel work it started. Labels
 * wrap; a closed branch folds unless a fork is still open under it.
 */
export const paneRows = (
  trail: Trail,
  work: readonly TrailWork[],
  now: number,
  columns = WIDE,
  opened: string | null = null,
  unfolded: readonly string[] = [],
  isCompact = false,
): PaneRow[] => {
  const rows: PaneRow[] = []
  const running = runningOf(work)
  const here = nodeOf(trail, trail.cursor)
  const put = (
    lead: string,
    hang: string,
    label: string,
    tone: PaneRow['tone'],
    fork?: { id: string; title: string },
  ) => {
    wrap(label, Math.max(NARROWEST, columns - lead.length)).forEach((line, index) =>
      rows.push({
        text: `${index === 0 ? lead : hang}${line}`,
        tone,
        // The mark is the last two cells of the lead; the tree's lines stand before it.
        ...(fork !== undefined && {
          fork: { id: fork.id, title: fork.title, line: index, at: lead.length - 2 },
        }),
      }),
    )
  }
  // What an opened fork shows under itself: how it stands, and what can be done with it.
  const openUp = (indent: string, fork: { id: string; title: string }, detail: string) => {
    put(`${indent}  `, `${indent}  `, detail, 'dim')
    rows.push({ text: `${indent}  `, tone: 'plain', act: { id: fork.id, title: fork.title } })
  }
  const section = (title: string) => {
    rows.push({ text: '', tone: 'head' }, { text: title, tone: 'title' })
  }

  if (trail.isTripped) {
    rows.push({ text: 'LIMIT CROSSED', tone: 'warn' })
  }

  // Seated above the prompt the pane is short and the band below it says where the work is: the rows go to the tree.
  if (isCompact && here !== undefined) {
    // nothing above the tree
  } else if (trail.nodes.length === 0) {
    rows.push({ text: 'No goal set', tone: 'head' })
  } else if (here === undefined) {
    rows.push({ text: 'The goal is closed', tone: 'head' })
  } else {
    const off = mainOf(trail)
    const since = span(now - (here.startedAt ?? now))
    const where =
      depthOf(trail) > 0
        ? `detour · ${since} · off «${off?.title ?? ''}»`
        : here.kind === 'goal'
          ? 'between tasks'
          : `in progress · ${since}`
    const counts = countsText(trail, running)

    put('NOW   ', '      ', here.title, 'open')
    put('      ', '      ', where, depthOf(trail) > 0 ? 'warn' : 'head')

    if (counts !== '') {
      put('OPEN  ', '      ', counts, 'head')
    }
  }

  if (trail.nodes.length > 0 && rows.length > 0) {
    rows.push({ text: '', tone: 'head' })
  }

  const known = new Set(trail.nodes.map(node => node.id))
  const jobs = new Set(work.map(item => item.id))
  // Started by the main conversation, or by an agent the pane does not know: shown at the top level either way.
  const isTop = (item: TrailWork) => item.parentId === null || !jobs.has(item.parentId)
  const kidsOf = (id: string) => trail.nodes.filter(node => node.parentId === id)
  const rootId = trail.nodes.find(node => node.parentId === null)?.id ?? null
  const isOver = (node: TrailNode) => node.state === 'done' || node.state === 'dropped'
  /**
   * Where an open fork hangs: under the node it was raised in while that node
   * is still open; once it is finished, under the nearest one above that is
   * not, in the end the root. A finished task never stays in view for its forks.
   */
  const homeOf = (item: TrailParked): string | null => {
    let node = item.fromId === null ? undefined : nodeOf(trail, item.fromId)

    while (node !== undefined && isOver(node) && node.parentId !== null) {
      node = nodeOf(trail, node.parentId)
    }

    return node?.id ?? rootId
  }
  const forksOf = (id: string) => trail.parked.filter(item => item.isOpen && homeOf(item) === id)
  const isClosed = (node: TrailNode): boolean =>
    isOver(node) &&
    kidsOf(node.id).every(isClosed) &&
    !work.some(item => item.nodeId === node.id && item.state === 'running')

  // The root is not drawn: what hangs directly under it stands at the left edge, without the tree's lines.
  const leaf = (
    item: TrailParked,
    prefix: string,
    isLast: boolean,
    isOuter: boolean,
    isGrouped = false,
  ) => {
    const isQuestion = isAsk(item)
    const isOpened = item.id === opened
    const below = isOuter ? '' : `${prefix}${isLast ? '  ' : '│ '}`

    put(
      `${isOuter ? '' : `${prefix}${isLast ? '└ ' : '├ '}`}${isOpened ? '▾' : isQuestion ? '?' : '·'} `,
      `${below}  `,
      // Under the heading that already says "decide", the word is not repeated on every row.
      `${isGrouped ? item.title.replace(/^decide:?\s*/i, '') : item.title} [${item.id}]`,
      isQuestion ? 'ask' : 'note',
      item,
    )

    if (isOpened) {
      // Lifted out of a finished task, the fork says where it came from.
      const from = item.fromId === null ? undefined : nodeOf(trail, item.fromId)
      const origin = from !== undefined && from.parentId !== null && from.id !== homeOf(item) ? `from «${from.title}» · ` : ''

      openUp(below, item, `${origin}raised ${span(now - item.at)} ago`)
    }
  }

  const job = (item: TrailWork, prefix: string, isLast: boolean, isOuter = false) => {
    const under = work.filter(one => one.parentId === item.id)
    const below = isOuter ? '' : `${prefix}${isLast ? '  ' : '│ '}`

    put(
      `${isOuter ? '' : `${prefix}${isLast ? '└ ' : '├ '}`}${WORK_MARKS[item.state]} `,
      `${below}  `,
      workLabel(item, now),
      workTone(item),
    )
    under.forEach((one, index) => job(one, below, index === under.length - 1))
  }

  const walk = (node: TrailNode, prefix: string, isLast: boolean, level: number) => {
    const label = node.kind === 'detour' ? `detour: ${node.title}` : node.title
    const isRoot = level === 0
    const isOuter = level === 1
    const below = isRoot || isOuter ? '' : `${prefix}${isLast ? '  ' : '│ '}`
    const kids = kidsOf(node.id)
    // Every closed branch stands in one row at the bottom; pressed, the row shows them all beneath it.
    const older = kids.filter(isClosed)
    const isUnfolded = unfolded.includes(node.id)
    const forks = forksOf(node.id)
    // At the left edge the forks stand in two groups, by what the person has to do with them.
    const groups: Group[] = isRoot
      ? [
          { heading: 'FOR YOU TO DECIDE', tone: 'ask' as const, items: forks.filter(isAsk) },
          { heading: 'NOTED, NOT DONE', tone: 'note' as const, items: forks.filter(item => !isAsk(item)) },
        ].filter(group => group.items.length > 0)
      : []
    const shown: (TrailNode | TrailParked | TrailWork | Group | number)[] = [
      ...kids.filter(one => !isClosed(one)),
      ...(isRoot ? [] : forks),
      // Under a task a finished job stays until the task folds away; the session never folds,
      // so a job started between tasks is shown only while it runs.
      ...work.filter(item => item.nodeId === node.id && isTop(item) && (!isRoot || item.state === 'running')),
      ...groups,
      ...(older.length > 0 ? [older.length] : []),
      ...(isUnfolded ? older : []),
    ]
    // A task left unfinished is a fork too: it opens up like one.
    const isFork = isLooseEnd(node)
    const isOpened = isFork && node.id === opened

    // A finished task still in view (work of its own still running, or a step not closed) is only a heading: no tick, which would read as "all done".
    const isHeading = isOver(node) && !isClosed(node)

    if (!isRoot) {
      put(
        `${isOuter ? '' : `${prefix}${isLast ? '└ ' : '├ '}`}${isOpened ? '▾' : isHeading ? ' ' : markOf(node)} `,
        `${below}  `,
        `${label}${isFork ? ` (left open) [${node.id}]` : ''}${isHeading ? ` (${node.state})` : ''}`,
        isHeading ? 'dim' : toneOf(trail, node),
        isFork ? node : undefined,
      )
    }

    if (isOpened) {
      openUp(
        below,
        node,
        `${node.outcome === null ? 'left unfinished' : `left unfinished: ${node.outcome}`} · ${span(now - (node.startedAt ?? now))} ago`,
      )
    }

    shown.forEach((one, index) => {
      const isEnd = index === shown.length - 1

      if (typeof one === 'number') {
        const lead = isRoot ? '' : `${below}${isEnd ? '└ ' : '├ '}`

        rows.push({
          text: `${lead}${isUnfolded ? '▾' : '✓'} ${one} earlier, closed`,
          tone: 'dim',
          fold: { id: node.id, at: lead.length },
        })
      } else if ('nodeId' in one) {
        job(one, below, isEnd, isRoot)
      } else if ('heading' in one) {
        rows.push({ text: one.heading, tone: one.tone })
        one.items.forEach((item, index) => leaf(item, '', index === one.items.length - 1, false, true))
      } else if ('isOpen' in one) {
        leaf(one, below, isEnd, isRoot)
      } else {
        walk(one, below, isEnd, level + 1)
      }
    })
  }

  for (const root of trail.nodes.filter(node => node.parentId === null)) {
    walk(root, '', true, 0)
  }

  const loose = work.filter(
    item => isTop(item) && (item.nodeId === null || !known.has(item.nodeId)),
  )
  const kept = [
    ...loose.filter(item => item.state !== 'running').slice(-LOOSE_SHOWN),
    ...loose.filter(item => item.state === 'running'),
  ]

  if (kept.length > 0) {
    section('OTHER WORK')
    kept.forEach((item, index) => job(item, '', index === kept.length - 1, true))
  }

  // The root is not drawn, so a trail with nothing under it yet would be an empty pane.
  if (rows.length === 0) {
    rows.push({ text: 'Nothing noted yet', tone: 'dim' })
  }

  return rows
}
