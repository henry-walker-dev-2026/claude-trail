import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY,
  addSteps,
  advance,
  confirm,
  decisionsText,
  depthOf,
  enter,
  fix,
  leave,
  noteText,
  paneRows,
  park,
  pathText,
  prompted,
  setGoal,
  statsText,
  stripRows,
  tick,
  tidy,
  treeText,
  tripOf,
  tripText,
  unpark,
} from '../hooks/model'
import type { Trail, TrailWork } from '../types'
import { fixture } from './fixtures/strip-tree'

const LIMITS = { depth: 2, minutes: 30, prompts: 5 }

const started = (): Trail =>
  addSteps(setGoal(EMPTY, 'Migrate auth to OAuth', 0), [
    'token endpoint',
    'login flow',
    'logout flow',
  ])

const times = (trail: Trail, count: number, apply: (held: Trail) => Trail) =>
  Array.from({ length: count }).reduce<Trail>(held => apply(held), trail)

describe('the path', () => {
  test('a goal with planned steps starts on the goal', () => {
    const trail = started()

    expect(pathText(trail)).toBe('Migrate auth to OAuth')
    expect(statsText(trail)).toBe('0/3 steps')
    expect(depthOf(trail)).toBe(0)
  })

  test('entering a planned step by title or id moves to it, never duplicates it', () => {
    const byTitle = enter(started(), 'Login Flow', 'step', 1)
    const byId = enter(started(), 'n3', 'step', 1)

    expect(pathText(byTitle)).toBe('Migrate auth to OAuth › login flow')
    expect(pathText(byId)).toBe('Migrate auth to OAuth › login flow')
    expect(byTitle.nodes.length).toBe(4)
    expect(byId.nodes.length).toBe(4)
  })

  test('a detour nests under the current node and leaving returns to it', () => {
    const inStep = enter(started(), 'login flow', 'step', 1)
    const inDetour = enter(inStep, 'failing session test', 'detour', 2)

    expect(pathText(inDetour)).toBe(
      'Migrate auth to OAuth › login flow › failing session test',
    )
    expect(depthOf(inDetour)).toBe(1)

    const back = leave(inDetour, 'done', 'fixture was stale', 3)

    expect(pathText(back)).toBe('Migrate auth to OAuth › login flow')
    expect(depthOf(back)).toBe(0)
    expect(treeText(back)).toContain('✓ detour: failing session test')
    expect(treeText(back)).toContain('(fixture was stale)')
  })

  test('a step entered inside a detour is still off the main line', () => {
    const inDetour = enter(
      enter(started(), 'login flow', 'step', 1),
      'rewrite the test harness',
      'detour',
      2,
    )
    const inSubStep = enter(inDetour, 'port the fixtures', 'step', 3)

    expect(depthOf(inSubStep)).toBe(1)
  })

  test('a node left open is a loose end that can be entered again', () => {
    const inDetour = enter(
      enter(started(), 'login flow', 'step', 1),
      'flaky CI job',
      'detour',
      2,
    )
    const left = leave(inDetour, 'open', null, 3)

    expect(statsText(left)).toContain('1 left open')
    expect(treeText(left)).toContain('◌ detour: flaky CI job')

    const again = enter(left, 'flaky CI job', 'detour', 4)

    expect(again.nodes.length).toBe(left.nodes.length)
    expect(pathText(again)).toBe('Migrate auth to OAuth › login flow › flaky CI job')
  })

  test('jumping to another planned step leaves what was active open', () => {
    const inDetour = enter(
      enter(started(), 'login flow', 'step', 1),
      'failing session test',
      'detour',
      2,
    )
    const jumped = enter(inDetour, 'logout flow', 'step', 3)

    expect(pathText(jumped)).toBe('Migrate auth to OAuth › logout flow')
    expect(statsText(jumped)).toContain('2 left open')
  })

  test('leaving the goal ends the trail, and a new goal keeps the open parked items', () => {
    const parked = park(started(), 'rename SessionStore', 1)
    const ended = leave(parked, 'done', 'shipped', 2)

    expect(ended.cursor).toBe(null)

    const next = setGoal(ended, 'Add rate limiting', 3)

    expect(pathText(next)).toBe('Add rate limiting')
    expect(next.nodes.length).toBe(1)
    expect(treeText(next)).toContain('· rename SessionStore')
  })

  test('fix corrects the title and the kind of the current node', () => {
    const inDetour = enter(started(), 'audit the callbacks', 'detour', 1)
    const fixed = fix(inDetour, 'audit the redirect callbacks', 'step')

    expect(pathText(fixed)).toBe(
      'Migrate auth to OAuth › audit the redirect callbacks',
    )
    expect(depthOf(fixed)).toBe(0)
  })

  test('titles are one line, cut at eighty characters', () => {
    const trail = setGoal(EMPTY, `  a\n  goal ${'x'.repeat(400)}`, 0)

    expect(pathText(trail).length).toBe(80)
    expect(pathText(trail).startsWith('a goal x')).toBe(true)
  })
})

describe('next and parked items', () => {
  test('next closes the current step as done and enters the one named', () => {
    const inFirst = advance(started(), 'n2', 'step', null, 1)
    const inSecond = advance(inFirst, 'n3', 'step', 'returns a token', 2)

    expect(pathText(inFirst)).toBe('Migrate auth to OAuth › token endpoint')
    expect(pathText(inSecond)).toBe('Migrate auth to OAuth › login flow')
    expect(inSecond.nodes.length).toBe(4)
    expect(treeText(inSecond)).toContain('✓ token endpoint [n2] (returns a token)')
    expect(statsText(inSecond)).toBe('1/3 steps')
  })

  test('moving on without an outcome leaves the node open, never done', () => {
    const session = setGoal(EMPTY, 'Session', 0)
    const first = enter(session, 'Add timeout fix', 'step', 1)
    const moved = advance(first, 'Compare changed data', 'step', null, 2)

    expect(treeText(moved)).toContain('◌ Add timeout fix [n2] (left open)')
    expect(statsText(moved)).toBe('0/2 steps · 1 left open')
    expect(treeText(advance(first, 'Compare changed data', 'step', null, 2, 'dropped'))).toContain(
      '✗ Add timeout fix [n2]',
    )
    expect(treeText(advance(first, 'Compare changed data', 'step', null, 2, 'done'))).toContain(
      '◌ Add timeout fix [n2] (left open)',
    )
  })

  test('a title names the step of the task being worked on, not one of the same name elsewhere', () => {
    const session = setGoal(EMPTY, 'Session', 0)
    const first = addSteps(enter(session, 'Task A', 'step', 1), ['Test'])
    const second = addSteps(enter(leave(first, 'open', null, 2), 'Task B', 'step', 3), ['Test'])

    expect(pathText(enter(second, 'Test', 'step', 4))).toBe('Session › Task B › Test')
    expect(pathText(enter(second, 'n3', 'step', 4))).toBe('Session › Task A › Test')
  })

  test('from one detour straight into another, the episode and its counters go on', () => {
    const inDetour = times(enter(enter(started(), 'n3', 'step', 1), 'failing test', 'detour', 2), 20, tick)
    const moved = advance(inDetour, 'test DB down', 'detour', 'not the cause', 3)

    expect(pathText(moved)).toBe('Migrate auth to OAuth › login flow › test DB down')
    expect(moved.detourMinutes).toBe(20)
    expect(advance(inDetour, 'n4', 'step', 'fixed', 3).detourMinutes).toBe(0)
  })

  test('a step inside a detour is still off the task the detour left', () => {
    const inside = enter(
      enter(enter(started(), 'n3', 'step', 1), 'rewrite the harness', 'detour', 2),
      'port the fixtures',
      'step',
      3,
    )

    expect(tripText(inside, 'x')).toContain('it is off «login flow»')
    expect(paneRows(inside, [], 3)[1]?.text).toBe('      detour · under 1 min · off «login flow»')
  })

  test('every closed branch folds into the one row, whatever the order they closed in', () => {
    let trail = setGoal(EMPTY, 'Session', 0)

    for (const title of ['a', 'b', 'c', 'd']) {
      trail = leave(enter(trail, title, 'step', 1), 'open', null, 2)
    }

    trail = leave(enter(trail, 'd', 'step', 3), 'done', null, 4)
    trail = leave(enter(trail, 'c', 'step', 5), 'done', null, 6)
    trail = leave(enter(trail, 'b', 'step', 7), 'done', null, 8)
    trail = leave(enter(trail, 'a', 'step', 9), 'done', null, 10)

    const rows = paneRows(trail, [], 10).map(row => row.text)

    expect(rows.slice(-1)).toEqual(['✓ 4 earlier, closed'])
  })

  test('next out of a detour closes the detour, not the step above it', () => {
    const inDetour = enter(enter(started(), 'n3', 'step', 1), 'failing test', 'detour', 2)
    const after = advance(inDetour, 'n4', 'step', 'fixture was stale', 3)

    expect(pathText(after)).toBe('Migrate auth to OAuth › logout flow')
    expect(treeText(after)).toContain('✓ detour: failing test')
    expect(treeText(after)).toContain('◌ login flow [n3] (left open)')
  })

  test('a parked item entered by its id becomes the node and stops waiting', () => {
    const parked = park(started(), 'rename SessionStore', 1)
    const picked = enter(parked, 'p5', 'step', 2)

    expect(pathText(picked)).toBe('Migrate auth to OAuth › rename SessionStore')
    expect(statsText(picked)).not.toContain('parked')
  })

  test('unpark takes a parked item off the list by id or title, and nothing else', () => {
    const parked = park(park(started(), 'rename SessionStore', 1), 'flaky CI job', 2)

    expect(treeText(parked)).toContain('· rename SessionStore [p5]')
    expect(statsText(unpark(parked, 'p5'))).toContain('1 parked')
    expect(statsText(unpark(unpark(parked, 'p5'), 'Flaky CI job'))).not.toContain('parked')
    expect(unpark(parked, 'p9')).toBe(parked)
  })
})

describe('a task given up', () => {
  test('takes its never-started planned steps with it, and they no longer count', () => {
    const session = setGoal(EMPTY, 'Session', 0)
    const planned = addSteps(enter(session, 'Stricter input checks', 'step', 1), ['Read the helper', 'Tests', 'Fold in'])
    const begun = leave(enter(planned, 'Read the helper', 'step', 2), 'done', 'read', 3)
    const dropped = leave(begun, 'dropped', null, 4)

    expect(treeText(dropped)).toContain('✗ Tests')
    expect(treeText(dropped)).toContain('✓ Read the helper')
    expect(statsText(dropped)).toBe('1/1 steps')
    expect(tidy(dropped)).toBe(dropped)
  })
})

describe('the pane', () => {
  const job = (id: string, more: Partial<TrailWork> = {}): TrailWork => ({
    id,
    kind: 'agent',
    title: id,
    nodeId: null,
    parentId: null,
    state: 'running',
    startedAt: 0,
    endedAt: null,
    ...more,
  })
  const texts = (trail: Trail, work: TrailWork[] = [], now = 0, columns?: number) =>
    paneRows(trail, work, now, columns).map(row => row.text)

  test('closed branches fold into one row; only what is open or being worked on stays in view', () => {
    let trail = setGoal(EMPTY, 'Goal', 0)

    for (const title of ['a', 'b', 'c', 'd', 'e']) {
      trail = leave(enter(trail, title, 'detour', 1), 'done', null, 2)
    }

    trail = enter(trail, 'f', 'detour', 3)

    expect(texts(trail)).toEqual([
      'NOW   f',
      '      detour · under 1 min · off «Goal»',
      '',
      '▸ detour: f',
      '✓ 5 earlier, closed',
    ])
    expect(paneRows(trail, [], 0).at(-2)?.tone).toBe('here')
  })

  test('a closed branch with work still running under it does not fold', () => {
    let trail = setGoal(EMPTY, 'Goal', 0)

    for (const title of ['a', 'b', 'c', 'd']) {
      trail = leave(enter(trail, title, 'detour', 1), 'done', null, 2)
    }

    const rows = texts(trail, [job('watcher', { nodeId: 'n2', kind: 'shell' })], 5 * 60_000)

    expect(rows.slice(-3)).toEqual([
      '  detour: a (done)',
      '└ ● shell · watcher · 5 min',
      '✓ 3 earlier, closed',
    ])
  })

  test('work started with no goal, or under a trail that is gone, is listed apart', () => {
    const rows = texts(EMPTY, [
      job('old', { state: 'done', endedAt: 60_000 }),
      job('live', { nodeId: 'n99' }),
    ], 125 * 60_000)

    expect(rows).toEqual([
      'No goal set',
      '',
      'OTHER WORK',
      '✓ agent · old · done after 1 min',
      '● agent · live · 2 h 05',
    ])
  })

  test('labels wrap between words to the pane\'s width and keep the tree\'s indent', () => {
    const trail = enter(
      enter(started(), 'login flow', 'step', 0),
      'the session test fails on a stale fixture file',
      'detour',
      0,
    )

    expect(texts(trail, [], 12 * 60_000, 34)).toEqual([
      'NOW   the session test fails on a',
      '      stale fixture file',
      '      detour · 12 min · off «login',
      '      flow»',
      '',
      '○ token endpoint',
      '▸ login flow',
      '└ ▸ detour: the session test fails',
      '    on a stale fixture file',
      '○ logout flow',
    ])
  })

  test('a node left open is marked, and a finished trail says so', () => {
    const left = leave(enter(started(), 'flaky CI job', 'detour', 1), 'open', null, 2)

    expect(texts(left)).toContain('◌ detour: flaky CI job (left open) [n5]')
    expect(paneRows(left, [], 0).at(-1)?.tone).toBe('warn')
    expect(texts(left).slice(0, 3)).toEqual([
      'NOW   Migrate auth to OAuth',
      '      between tasks',
      'OPEN  1 unfinished',
    ])
    expect(paneRows({ ...left, isTripped: true }, [], 0)[0]).toEqual({
      text: 'LIMIT CROSSED',
      tone: 'warn',
    })
    expect(texts(leave(started(), 'done', 'shipped', 3))[0]).toBe('The goal is closed')
  })
})

describe('the tripwire', () => {
  const inDetour = () =>
    enter(enter(started(), 'login flow', 'step', 1), 'failing test', 'detour', 2)

  test('one detour does not trip', () => {
    expect(tripOf(inDetour(), LIMITS)).toBe(null)
  })

  test('nested detours trip at the depth limit', () => {
    const deep = enter(inDetour(), 'test DB will not start', 'detour', 3)

    expect(tripOf(deep, LIMITS)).toBe('detours are nested 2 deep')
  })

  test('working minutes in detours trip at the limit, and only in detours', () => {
    expect(tripOf(times(inDetour(), 29, tick), LIMITS)).toBe(null)
    expect(tripOf(times(inDetour(), 30, tick), LIMITS)).toBe(
      '30 working minutes have gone into detours',
    )
    expect(times(started(), 30, tick).detourMinutes).toBe(0)
  })

  test('the person’s prompts in detours trip at the limit', () => {
    expect(tripOf(times(inDetour(), 4, prompted), LIMITS)).toBe(null)
    expect(tripOf(times(inDetour(), 5, prompted), LIMITS)).toContain(
      '5 of the person',
    )
  })

  test('it fires once per episode and re-arms on the main line', () => {
    const tripped = { ...times(inDetour(), 30, tick), isTripped: true }

    expect(tripOf(tripped, LIMITS)).toBe(null)

    const back = leave(tripped, 'done', null, 9)

    expect(back.isTripped).toBe(false)
    expect(back.detourMinutes).toBe(0)

    const again = times(enter(back, 'another blocker', 'detour', 10), 30, tick)

    expect(tripOf(again, LIMITS)).toContain('30 working minutes')
  })

  test('a deeper detour does not restart the episode’s clock', () => {
    const deeper = enter(times(inDetour(), 20, tick), 'deeper', 'detour', 5)

    expect(deeper.detourMinutes).toBe(20)
  })
})

describe('tasks under a session', () => {
  test('planned steps go under the task being worked on, not under the root', () => {
    const inTask = enter(setGoal(EMPTY, 'Session', 0), 'Compare changed data', 'step', 1)
    const planned = addSteps(inTask, ['Build the page', 'Review every item'])

    expect(treeText(planned)).toContain('  ▸ Compare changed data [n2] ← here\n    ○ Build the page [n3]')
    expect(pathText(enter(planned, 'n4', 'step', 2))).toBe(
      'Session › Compare changed data › Review every item',
    )
  })

  test('the note names what was left open, with its id', () => {
    const session = setGoal(EMPTY, 'Session', 0)
    const left = leave(enter(session, 'Add timeout fix', 'step', 1), 'open', null, 2)
    const later = enter(left, 'Compare changed data', 'step', 3)

    expect(noteText(later)).toBe(
      '[trail] Session › Compare changed data (0/2 steps · 1 left open)\nLeft open, continue by id: [n2] Add timeout fix',
    )
    const backOnIt = enter(leave(later, 'done', 'compared', 4), 'n2', 'step', 5)

    expect(noteText(leave(backOnIt, 'done', 'fixed', 6))).toBe('[trail] Session (2/2 steps)')
  })
})

describe('the decisions waiting', () => {
  test('the note names them newest first with their ids and folds the older ones; noted forks stay out', () => {
    const session = setGoal(EMPTY, 'Session', 0)
    const ten = Array.from({ length: 10 }).reduce<Trail>(
      (held, _, index) => park(held, `Decision ${index + 1}`, index + 1, null, true),
      session,
    )
    const noted = park(ten, 'Only noted', 20)
    const note = noteText(noted)

    expect(note).toContain('Decisions waiting, settle by id what is taken: [p11] Decision 10; [p10] Decision 9')
    expect(note).toContain('[p4] Decision 3 (+2 older)')
    expect(note).not.toContain('Only noted')
    expect(decisionsText(unpark(noted, 'p11'))).toContain('[p10] Decision 9; [p9] Decision 8')
    expect(decisionsText(session)).toBe('')
  })
})

describe('the path note', () => {
  test('is one line: the path and the counts', () => {
    expect(noteText(enter(started(), 'token endpoint', 'step', 1))).toBe(
      '[trail] Migrate auth to OAuth › token endpoint (0/3 steps)',
    )
  })

  test('asks for a confirmation after three prompts without an update', () => {
    const stale = times(started(), 3, prompted)

    expect(noteText(stale)).toContain('has not been updated for 3 prompts')
    expect(statsText(stale)).toContain('not updated for 3 prompts')
    expect(noteText(confirm(stale))).not.toContain('has not been updated')
  })
})

describe('the strip above the prompt', () => {
  // The fixture is a two-day session: 81 nodes, 95 open forks of which 16 wait for a decision, one task left open.
  const NOW = Math.max(...fixture.trail.parked.map(item => item.at)) + 5 * 60_000

  test('shows the task at hand, then the decisions newest first, one row each within the room', () => {
    const { rows, hidden } = stripRows(fixture.trail, fixture.work, NOW, 116, 7)

    expect(rows.length).toBe(7)
    expect(rows[0]?.text.startsWith('▸ Task 251 ')).toBe(true)
    expect(rows[0]?.tone).toBe('here')
    expect(rows[1]?.text.startsWith('? Decision 250 ')).toBe(true)
    expect(rows[1]?.text).toContain('[p250] · 5 min')
    expect(rows[1]?.fork).toEqual({ id: 'p250', title: fixture.trail.parked.find(item => item.id === 'p250')?.title, line: 0, at: 0 })
    expect(rows[2]?.text).toContain('[p235]')
    expect(rows.every(row => row.text.length <= 116)).toBe(true)
    expect(hidden).toBe('10 more decisions, 1 more unfinished, 79 more noted')
  })

  test('cuts titles to the width and keeps the id and the age', () => {
    const { rows } = stripRows(fixture.trail, fixture.work, NOW, 40, 7)

    expect(rows.every(row => row.text.length <= 40)).toBe(true)
    expect(rows[1]?.text).toMatch(/^\? Decision 250 .*… \[p250\] · 5 min$/)
    expect(rows[0]?.text).toMatch(/^▸ Task 251 .*… · /)
  })

  test('in a narrow band the age gives way before the id does', () => {
    const { rows } = stripRows(fixture.trail, fixture.work, NOW, 24, 7)

    expect(rows[1]?.text).toMatch(/^\? Decis.*… \[p250\]$/)
    expect(rows.every(row => row.text.length <= 24)).toBe(true)
  })

  test('with little room the strip is the task and the newest decisions, and the rest is counted', () => {
    const { rows, hidden } = stripRows(fixture.trail, fixture.work, NOW, 116, 3)

    expect(rows.map(row => row.text.slice(0, 1))).toEqual(['▸', '?', '?'])
    expect(hidden).toBe('14 more decisions, 1 more unfinished, 79 more noted')
  })

  test('a pressed fork opens up in the strip too: where it came from, take up and drop', () => {
    const { rows } = stripRows(fixture.trail, fixture.work, NOW, 116, 7, 'p250')

    expect(rows[1]?.text.startsWith('▾ Decision 250 ')).toBe(true)
    expect(rows[2]?.text).toMatch(/^ {2}(from «.*» · )?raised 5 min ago$/)
    expect(rows[3]?.act).toEqual({ id: 'p250', title: fixture.trail.parked.find(item => item.id === 'p250')?.title })
  })

  test('once the decisions are shown the tasks left open come, then the forks only noted', () => {
    const { rows, hidden } = stripRows(fixture.trail, fixture.work, NOW, 116, 19)

    expect(rows[17]?.text).toMatch(/^◌ Task 187 .* \(left open\) \[n187\] · /)
    expect(rows[18]?.text.startsWith('· Fork 249 ')).toBe(true)
    expect(hidden).toBe('78 more noted')
  })

  test('between tasks there is no task row, and a fork of the session fills it', () => {
    const session = setGoal(EMPTY, 'Session', 0)
    const three = park(park(park(session, 'Fork one', 1), 'Fork two', 2), 'Fork three', 3)
    const { rows, hidden } = stripRows(three, [], 4 * 60_000, 60, 2)

    expect(rows.map(row => row.text)).toEqual(['· Fork three [p4] · 3 min', '· Fork two [p3] · 3 min'])
    expect(hidden).toBe('1 more noted')
  })
})
