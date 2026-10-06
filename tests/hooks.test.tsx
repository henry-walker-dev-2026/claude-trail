import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import type { Trail } from '../types'

const TRACK = 'mcp__trail__track'
const MINUTE = 60_000
const COMPOSER = { kind: 'composer' } as const
const BAND = {
  plugin: 'trail',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'trail',
  component: 'Pane',
  requestId: 'trail',
  props: {
    title: 'Trail',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** Whether the test's surface seats the pane. */
let isPanePlaced = false

/** The tools the mod has registered with the engine in the running test. */
let draft = ''
let askedRows: unknown[] = []
let toasted: string[] = []
let filled: { text: string; mode: string }[] = []
let registered: string[] = []

/** The prompts the mod has submitted by itself in the running test. */
let kicked: string[] = []

/** What the mod wrote to the log in the running test. */
let logged: string[] = []

/** How many prompts the person has sent before the test begins. */
let turns = 0

/** Background shells started in the running test: the first is bash-1, the next bash-2. */
let shells = 0

/** What the engine lists as this session's agents in the running test. */
let listed: { id: string; description: string; type: string; status: string }[] = []

const spawn = (
  $: Engine,
  description: string,
  more: { fork?: boolean; parentAgentId?: string; isTeammate?: true } = {},
) =>
  $.agent.spawn({
    tool_use_id: `call-${description}`,
    prompt: 'do it',
    description,
    subagentType: more.isTeammate === true ? 'teammate' : 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test',
    background: true,
    fork: more.fork ?? false,
    ...(more.parentAgentId !== undefined && { parentAgentId: more.parentAgentId }),
    ...(more.isTeammate === true && { isTeammate: true as const }),
  })

/** A background job's notice, as the engine writes it into the prompt queue. */
const notice = ($: Engine, body: string) =>
  $.prompt.submit({
    text: `<task-notification>\n${body}\n</task-notification>`,
    wait: false,
    origin: { kind: 'task-notification' },
  })

/** The main conversation's turn ended; an agent's when `agentId` is given. */
const finish = ($: Engine, agentId?: string) =>
  $.turn.complete({
    turnId: `turn-${agentId ?? 'main'}`,
    answer: 'done',
    reason: 'answer',
    ...(agentId !== undefined && { agentId }),
  } as never)

/** The pane's rows as text: a row is a Text, or a Box holding a fork's mark and its Button, or its actions. */
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }

  if (node === null || typeof node !== 'object') {
    return ''
  }

  const one = node as { props?: { label?: unknown; children?: unknown }; children?: unknown }

  return typeof one.props?.label === 'string' ? one.props.label : textOf(one.children ?? one.props?.children)
}

/**
 * A drawing's rows as text. The band's frame is taken off: its top edge reads
 * as the title and the counts, its sides and its bottom edge are dropped.
 */
const rowsOf = async (pane: { findAll: (query: { type: string }) => Promise<{ children: unknown[] }[]> }) =>
  ((await pane.findAll({ type: 'Box' }))[0]?.children ?? [])
    .flat()
    .filter(row => row !== false && row !== null && row !== undefined)
    .map(textOf)
    .filter(row => !row.startsWith('╰'))
    .map(row => row.replace(/^╭─ Trail ─+ ?(.*)$/, 'Trail$1').replace(/^│ (.*) │$/, '$1'))

/** The rows of the tree: what follows the blank row under the pane's header. */
const tree = (rows: string[]) => rows.slice(rows.indexOf(' ') + 1)

const paneTexts = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const pane = await $.ui.mount({ ...PANE, surface })
  const texts = await rowsOf(pane)

  await pane.unmount()

  return texts
}

/** The engine beneath the mod, as far as these tests reach it; `kept` is a store the test reads. */
const boot = async (
  $: Engine,
  on: On,
  entries?: Record<string, unknown>,
  kept?: Map<string, unknown>,
) => {
  const clock = mock.clock(on, { now: 1_000 })

  registered = []
  kicked = []
  logged = []
  filled = []
  askedRows = []
  draft = ''
  toasted = []
  shells = 0
  listed = []

  if (kept === undefined) {
    mock.store(on, entries)
  } else {
    on('store.get', (_, e) => ({ value: kept.get(e.key) }))
    on('store.set', (_, e) => {
      kept.set(e.key, e.value)

      return { value: undefined }
    })
    on('store.delete', (_, e) => {
      kept.delete(e.key)

      return { value: undefined }
    })
  }

  on('session.id', () => ({ value: 'S1' }))
  on('session.turns', () => ({ value: turns }))
  on('agent.list', () => ({ value: listed as never }))
  on('agent.spawn', (_, e) => ({ model: 'test', agentId: `agent-${e.description}` }))
  on('ui.open', (_, e) => {
    askedRows.push(e.rows)

    return isPanePlaced
      ? { value: { isPlaced: true } }
      : { value: { isPlaced: false, reason: 'no surface in this test' } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('ui.toast', (_, e) => {
    toasted.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    filled.push({ text: e.text, mode: e.mode })

    return { isFilled: true, text: e.text }
  })
  on('ui.log', (_, e) => {
    logged.push(e.text)

    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    shells += 1

    return { result: { backgroundTaskId: `bash-${shells}` } as never }
  })
  on('tool.call', { tool: 'Monitor' }, () => ({ result: { backgroundTaskId: 'mon-1' } as never }))
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({
    result: { message: 'stopped', task_id: e.task_id, task_type: 'shell' } as never,
  }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => {
    registered.push(e.name)

    return { value: { tool: `mcp__trail__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_, e) =>
    e.instructions === 'refuse' ? { skip: 'refused' } : { messages: e.messages },
  )
  on('classic.SessionStart', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') {
      kicked.push(e.text)
    }

    return e.text === 'refused'
      ? { drop: 'refused beneath' }
      : { text: e.text, context: e.context }
  })
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }],
  }))
  on('tool.call', { tool: 'Read' }, () => ({ result: {} as never }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>nothing drawn</Text>
  })
  on('ui.render', { component: 'ToolUse' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>the engine's own row</Text>
  })
  on('ui.render', { component: 'UserMessage' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>the engine's own prompt row</Text>
  })
  on('ui.render', { component: 'ToolResult' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>the engine's own result</Text>
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  return clock
}

const track = async ($: Engine, input: Record<string, unknown>) => {
  const ran = await $.tool.call({ tool: TRACK, action: 'confirm', ...input })

  return ran.deny ?? String(ran.result)
}

const prompt = async ($: Engine, text = 'go on') => {
  const sent = await $.prompt.submit({ text, wait: false, origin: COMPOSER })

  return (sent.context ?? []).join('\n')
}

const read = async ($: Engine) => {
  const ran = await $.tool.call({ tool: 'Read', file_path: '/tmp/a' })

  return (ran.context ?? []).join('\n')
}

const command = async ($: Engine, args: string) => {
  const ran = await $.command.run({
    command: 'trail',
    args,
    origin: COMPOSER,
    presentation: { isFullscreen: true, columns: 120 },
  })

  return ran.text ?? ''
}

/** The person starts a trail; Claude then lists its steps. */
const start = async ($: Engine) => {
  await command($, 'goal Migrate auth to OAuth')

  return track($, {
    action: 'plan',
    steps: ['token endpoint', 'login flow', 'logout flow'],
  })
}

test('the tool sets the goal and the plan and answers the path with step ids', async ($, on) => {
  await boot($, on)

  expect(await track($, { action: 'enter', title: 'x', kind: 'step' })).toContain(
    'The person turns it on with /trail',
  )

  const planned = await start($)

  expect(planned).toContain('Migrate auth to OAuth (0/3 steps)')
  expect(planned).toContain('○ login flow [n3]')
  expect(await track($, { action: 'enter', title: 'n3', kind: 'step' })).toBe(
    'Migrate auth to OAuth › login flow (0/3 steps)',
  )
  expect(await track($, { action: 'leave', outcome: 'works' })).toBe(
    'Migrate auth to OAuth (1/3 steps)',
  )
  expect(await track($, { action: 'enter', title: 'x' })).toContain('needs kind')
  expect(await track($, { action: 'park' })).toContain('needs a title')
})

test('next closes the current step and enters the following one in one call', async ($, on) => {
  await boot($, on)
  await start($)

  expect(await track($, { action: 'next', title: 'n2' })).toBe(
    'Migrate auth to OAuth › token endpoint (0/3 steps)',
  )
  expect(await track($, { action: 'next', title: 'n3', outcome: 'returns a token' })).toBe(
    'Migrate auth to OAuth › login flow (1/3 steps)',
  )
  expect(await command($, 'text')).toContain('✓ token endpoint [n2] (returns a token)')
  expect(await track($, { action: 'next' })).toContain('needs a title')
})

test('a parked item is picked up by its id, or taken off the list', async ($, on) => {
  await boot($, on)
  await start($)
  await track($, { action: 'park', title: 'rename SessionStore' })
  await track($, { action: 'park', title: 'flaky CI job' })

  expect(await track($, { action: 'unpark', title: 'p9' })).toContain('no parked item «p9»')
  expect(await track($, { action: 'unpark', title: 'flaky ci job' })).toBe(
    'Migrate auth to OAuth (0/3 steps · 1 parked)',
  )
  expect(await track($, { action: 'enter', title: 'p5', kind: 'step' })).toBe(
    'Migrate auth to OAuth › rename SessionStore (0/4 steps)',
  )
})

test('a subagent cannot move the trail', async ($, on) => {
  await boot($, on)
  await start($)

  const ran = await $.tool.call({
    tool: TRACK,
    action: 'enter',
    title: 'side quest',
    kind: 'detour',
    agentId: 'agent-1',
  })

  expect(ran.deny).toContain('only the main conversation')
  expect(await command($, 'text')).not.toContain('side quest')
})

test('the path note rides the person’s prompts, and only while a goal is set', async ($, on) => {
  await boot($, on)

  expect(await prompt($)).toBe('')

  await start($)
  await track($, { action: 'enter', title: 'token endpoint', kind: 'step' })

  const note = await prompt($)

  expect(note).toBe('[trail] Migrate auth to OAuth › token endpoint (0/3 steps)')

  const notified = await $.prompt.submit({
    text: 'task done',
    wait: false,
    origin: { kind: 'task-notification' },
  })

  expect(notified.context).toBeUndefined()
})

test('the note asks for a confirmation after three prompts without an update', async ($, on) => {
  await boot($, on)
  await start($)
  await prompt($)
  await prompt($)

  expect(await prompt($)).toContain('has not been updated for 3 prompts')

  await track($, { action: 'confirm' })

  expect(await prompt($)).not.toContain('has not been updated')
})

test('nested detours trip the wire once, in the tool result', async ($, on) => {
  await boot($, on)
  await start($)
  await track($, { action: 'enter', title: 'login flow', kind: 'step' })

  const first = await track($, { action: 'enter', title: 'failing test', kind: 'detour' })
  const second = await track($, { action: 'enter', title: 'test DB down', kind: 'detour' })
  const third = await track($, { action: 'enter', title: 'docker broken', kind: 'detour' })

  expect(first).not.toContain('[trail tripwire]')
  expect(second).toContain('[trail tripwire] detours are nested 2 deep')
  expect(second).toContain('it is off «login flow»')
  expect(second).toContain('Do not mention the trail')
  expect(third).not.toContain('[trail tripwire]')
  expect(await prompt($)).not.toContain('[trail tripwire]')
})

test('the saved trail knows the wire has tripped', async ($, on) => {
  const kept = new Map<string, unknown>()

  await boot($, on, undefined, kept)
  await start($)
  await track($, { action: 'enter', title: 'failing test', kind: 'detour' })

  expect((kept.get('trail:S1') as Trail).isTripped).toBe(false)

  await track($, { action: 'enter', title: 'test DB down', kind: 'detour' })

  expect((kept.get('trail:S1') as Trail).isTripped).toBe(true)
})

test('a tripwire set to depth one says so in a sentence', { options: { detourDepth: 1 } }, async ($, on) => {
  await boot($, on)
  await start($)

  expect(await track($, { action: 'enter', title: 'failing test', kind: 'detour' })).toContain(
    '[trail tripwire] the work has left the main line for a detour',
  )
})

test('parallel work is saved beside the trail and comes back at the start', async ($, on) => {
  const kept = new Map<string, unknown>()

  await boot($, on, undefined, kept)
  await start($)
  await spawn($, 'find-examples')

  expect((kept.get('work:S1') as { id: string; state: string }[])[0]).toEqual(
    expect.objectContaining({ id: 'agent-find-examples', state: 'running', nodeId: 'n1' }),
  )
})

test('working minutes in a detour trip the wire into the next tool result', async ($, on) => {
  const clock = await boot($, on)

  await start($)
  await track($, { action: 'enter', title: 'failing test', kind: 'detour' })
  await clock.advance(40 * MINUTE)

  expect(await read($)).toBe('')

  await $.turn.start({ text: 'go on', turnId: 't1' })
  await clock.advance(29 * MINUTE)

  expect(await read($)).toBe('')

  await clock.advance(MINUTE)

  expect(await read($)).toContain('30 working minutes have gone into detours')
  expect(await read($)).toBe('')
  expect(await command($, 'text')).toContain('30 working min in detours')
})

test('the fifth prompt in a detour trips the wire, and the main line re-arms it', async ($, on) => {
  await boot($, on)
  await start($)
  await track($, { action: 'enter', title: 'failing test', kind: 'detour' })

  for (let sent = 0; sent < 4; sent += 1) {
    expect(await prompt($)).not.toContain('[trail tripwire]')
  }

  expect(await prompt($)).toContain("5 of the person's prompts")
  expect(await prompt($)).not.toContain('[trail tripwire]')

  await track($, { action: 'leave', as: 'open' })
  await track($, { action: 'enter', title: 'another blocker', kind: 'detour' })

  for (let sent = 0; sent < 4; sent += 1) {
    await prompt($)
  }

  expect(await prompt($)).toContain('[trail tripwire]')
})

test('a prompt refused beneath takes no note with it', async ($, on) => {
  await boot($, on)
  await start($)
  await track($, { action: 'enter', title: 'failing test', kind: 'detour' })

  for (let sent = 0; sent < 4; sent += 1) {
    await prompt($)
  }

  expect(await prompt($, 'refused')).toBe('')
  expect(await read($)).toContain('[trail tripwire]')
})

test('forty tool calls without an update ask for a confirmation', async ($, on) => {
  await boot($, on)
  await start($)

  for (let called = 0; called < 39; called += 1) {
    expect(await read($)).toBe('')
  }

  expect(await read($)).toContain('40 tool calls since the trail was last updated')
  expect(await read($)).toBe('')
})

test('the whole trail follows a compaction that was installed', async ($, on) => {
  const messages: SessionMessage[] = [{ role: 'user', text: 'hello', toolUses: [] }]

  await boot($, on)
  await start($)
  await $.session.compact({ trigger: 'precompute', messages })
  await $.session.compact({ trigger: 'auto', messages, instructions: 'refuse' })
  await $.session.compact({ trigger: 'auto', messages, agentId: 'agent-1' })

  expect(await read($)).toBe('')

  await $.session.compact({ trigger: 'auto', messages })

  const note = await read($)

  expect(note).toContain('What is open in the trail as it stands')
  expect(note).toContain('○ logout flow [n4]')
  expect(await read($)).toBe('')
})

test('the person reads and corrects the trail with /trail', async ($, on) => {
  await boot($, on)

  expect(await command($, 'back')).toContain('The trail is off')
  expect(await command($, 'goal Migrate auth to OAuth')).toBe('Trail on.')
  expect(await command($, 'goal Migrate auth to OAuth 2.1')).toBe(
    'Trail: the session is named «Migrate auth to OAuth 2.1».',
  )

  await track($, { action: 'enter', title: 'failing test', kind: 'detour' })

  expect(await command($, 'park rename SessionStore')).toContain('parked')
  expect(await command($, 'back')).toBe(
    'Trail: «failing test» is left open; the work is back on Migrate auth to OAuth 2.1.',
  )
  expect(await command($, 'back')).toContain('no task is open')

  const shown = await command($, 'text')

  expect(shown).toContain('◌ detour: failing test [n2] (left open)')
  expect(shown).toContain('· rename SessionStore [p3] (from: failing test)')
  expect(await command($, 'unpark p9')).toContain('no parked item')
  expect(await command($, 'unpark p3')).toBe('Trail: «rename SessionStore» is no longer parked.')
  expect(await command($, 'text')).not.toContain('rename SessionStore')

  await track($, { action: 'enter', title: 'n2', kind: 'detour' })

  expect(await command($, 'done fixture was stale')).toContain('is done')
  expect(await command($, 'text')).toContain('✓ detour: failing test [n2] (fixture was stale)')
  expect(await command($, 'toString')).toContain('Usage: /trail')
  expect(await command($, 'clear')).toBe('Trail cleared.')
  expect(await command($, 'text')).toContain('▸ Session [n')
  expect(await command($, 'off')).toBe('Trail off.')
  expect(await command($, 'text')).toContain('The trail is off')
})

test('the session itself is not left through the tool', async ($, on) => {
  await boot($, on)
  await start($)

  expect(await track($, { action: 'leave', outcome: 'shipped' })).toContain('nothing to leave')
  expect(await command($, 'back')).toContain('no task is open')
  expect(await command($, 'text')).toContain('▸ Migrate auth to OAuth [n1] ← here')
})

test('each thing the person asks for is a task under the session; what is left open is named and continued by id', async ($, on) => {
  await boot($, on)
  await command($, '')

  expect(await track($, { action: 'enter', title: 'Add timeout fix', kind: 'step' })).toBe(
    'Session › Add timeout fix (0/1 steps)',
  )
  expect(await track($, { action: 'leave', as: 'open', outcome: 'interrupted' })).toBe(
    'Session (0/1 steps · 1 left open)',
  )
  await track($, { action: 'enter', title: 'Compare changed data', kind: 'step' })
  await track($, { action: 'plan', steps: ['Build the page', 'Review every item'] })

  expect(await track($, { action: 'enter', title: 'Build the page', kind: 'step' })).toBe(
    'Session › Compare changed data › Build the page (0/4 steps · 1 left open)',
  )
  expect(await prompt($)).toBe(
    '[trail] Session › Compare changed data › Build the page (0/4 steps · 1 left open)\nLeft open, continue by id: [n2] Add timeout fix',
  )

  await track($, { action: 'leave', outcome: 'page built' })
  await track($, { action: 'next', title: 'n2', outcome: 'reviewed' })

  expect(await paneTexts($)).toEqual([
    'NOW   Add timeout fix',
    '      in progress · under 1 min',
    ' ',
    '▸ Add timeout fix',
    '  Compare changed data (done)',
    '├ ○ Review every item',
    '└ ✓ 1 earlier, closed',
  ])
})

test('above the prompt stands the tree under a line of counts, and nothing without a trail', async ($, on) => {
  await boot($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ ...BAND, surface })

    expect(await empty.find({ text: 'nothing drawn' })).toBeDefined()
  }

  await start($)
  await track($, { action: 'enter', title: 'login flow', kind: 'step' })
  await track($, { action: 'enter', title: 'failing test', kind: 'detour' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })

    expect(await rowsOf(band)).toEqual([
      'Trailin a detour, 0 working min',
      '○ token endpoint',
      '▸ login flow',
      '└ ▸ detour: failing test',
      '○ logout flow',
    ])
    expect((await band.find({ type: 'Text', text: /in a detour/ }))?.props.color).toBeUndefined()

    const survey = await $.ui.mount({
      ...BAND,
      surface,
      props: { ...BAND.props, hasSurvey: true },
    })

    expect(await survey.find({ text: 'nothing drawn' })).toBeDefined()
  }

  await track($, { action: 'enter', title: 'test DB down', kind: 'detour' })

  const tripped = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await tripped.find({ type: 'Text', text: /in a detour/ }))?.props.color).toBe('warning')
})

test('a trail saved under this session comes back at the start', async ($, on) => {
  const saved: Trail = {
    nodes: [
      {
        id: 'n1',
        kind: 'goal',
        title: 'Migrate auth to OAuth',
        state: 'active',
        parentId: null,
        startedAt: 1,
        endedAt: null,
        outcome: null,
      },
    ],
    cursor: 'n1',
    parked: [],
    seq: 1,
    detourMinutes: 0,
    detourPrompts: 0,
    promptsSinceUpdate: 0,
    isTripped: false,
  }

  await boot($, on, { 'trail:S1': saved, 'trail:other': saved })

  expect(await prompt($)).toContain('[trail] Migrate auth to OAuth')
})

test('on demand the mod adds nothing until the person turns the trail on; the session is then the root', async ($, on) => {
  await boot($, on)

  const compose = {
    model: 'claude-fable-5-1',
    promptModel: 'claude-fable-5-1',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  } as const
  const sections = async () =>
    (await $.prompt.compose(compose)).sections.map(section => section.id)

  expect(registered).toEqual([])
  expect(await sections()).toEqual(['intro'])
  expect(await prompt($)).toBe('')
  expect(await read($)).toBe('')
  expect(await track($, { action: 'enter', title: 'Sneak a task in', kind: 'step' })).toContain(
    'The person turns it on with /trail',
  )
  expect(await command($, 'text')).toContain('The trail is off')

  const turnedOn = await $.command.run({
    command: 'trail',
    args: '',
    origin: COMPOSER,
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(turnedOn.text).toBe('Trail on.')
  expect(turnedOn.context?.[0]).toContain('The root is the session')
  expect(turnedOn.context?.[0]).toContain('The person just turned the trail on')
  expect(registered).toEqual(['track'])
  expect(kicked).toEqual([])
  expect(await paneTexts($)).toEqual(['NOW   Session', '      between tasks', ' '])
  expect(await command($, 'text')).toContain('▸ Session [n1] ← here')
  expect(await prompt($)).toBe('[trail] Session (on the main line)')
  expect(await track($, { action: 'enter', title: 'Fix the generator', kind: 'step' })).toBe(
    'Session › Fix the generator (0/1 steps)',
  )
  expect(await track($, { action: 'goal', title: 'Migrate auth to OAuth' })).toContain(
    'Migrate auth to OAuth › Fix the generator (0/1 steps)',
  )
  expect(await sections()).toEqual(['intro'])
  expect(await command($, 'off')).toBe('Trail off.')
  expect(await prompt($)).toBe('')
  expect(await track($, { action: 'enter', title: 'Sneak a task in', kind: 'step' })).toContain(
    'The person turns it on with /trail',
  )
})

test('on and off are what the saved trail says: a root means on, an empty trail means off', async ($, on) => {
  const kept = new Map<string, unknown>()

  await boot($, on, undefined, kept)
  await command($, '')

  expect((kept.get('trail:S1') as Trail).cursor).toBe('n1')

  await command($, 'off')

  expect((kept.get('trail:S1') as Trail).cursor).toBe(null)
  expect(kept.get('work:S1')).toEqual([])
})

test('a restart restores the tree and the parallel work, and the trail is on again', async ($, on) => {
  const first = new Map<string, unknown>()

  await boot($, on, undefined, first)
  await command($, '')
  await track($, { action: 'enter', title: 'Compare changed data', kind: 'step' })
  await spawn($, 'find-examples')

  // A second boot stands for the next process: the engine keeps no state of the mod, the store does.
  registered = []
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  // Same rules as before the restart: nothing is said twice.
  expect(await prompt($)).toBe('[trail] Session › Compare changed data (0/1 steps)')

  // Rules changed since this session's model read them: the next prompt carries them and the whole tree, once.
  first.set('rules:S1', 'an older version')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const resumed = await prompt($)

  expect(resumed).toContain('[trail] Session › Compare changed data (0/1 steps)')
  expect(resumed).toContain('# Trail')
  expect(resumed).toContain('What is open in the trail as it stands')
  expect(await prompt($)).not.toContain('# Trail')
  // The engine lists no such agent after the restart, so the pane does not claim it still runs.
  expect(await paneTexts($)).toContain('└ ? agent · Explore: find-examples · unknown')
  expect((first.get('work:S1') as { id: string }[]).map(item => item.id)).toEqual([
    'agent-find-examples',
  ])
})

test('clearing or turning off drops the parallel work and what was owed, so nothing old attaches to a new tree', async ($, on) => {
  const clock = await boot($, on)

  await command($, '')
  await track($, { action: 'enter', title: 'Old task', kind: 'step' })
  await spawn($, 'old-agent')
  await track($, { action: 'enter', title: 'blocker', kind: 'detour' })
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await clock.advance(30 * MINUTE)

  expect(await command($, 'clear')).toBe('Trail cleared.')

  await track($, { action: 'enter', title: 'New task', kind: 'step' })

  expect(await paneTexts($)).toEqual([
    'NOW   New task',
    '      in progress · under 1 min',
    ' ',
    '▸ New task',
  ])
  expect(await read($)).toBe('')
  expect(await prompt($)).toBe('[trail] Session › New task (0/1 steps)')

  await command($, 'off')
  await command($, '')

  expect(await paneTexts($)).toEqual(['NOW   Session', '      between tasks', ' '])
})

test('a background task is filed under the node it started from and ends only on a final status', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Run the suite', kind: 'step' })
  await $.tool.call({
    tool: 'Bash',
    command: 'make test',
    description: 'Run the long test job',
    run_in_background: true,
  })
  await track($, { action: 'next', title: 'Write the report', outcome: 'suite started' })

  const notify = (status: string) =>
    $.prompt.submit({
      text: `<task-notification>\n<task-id> bash-1 </task-id>\n<status>${status}</status>\n</task-notification>`,
      wait: false,
      origin: { kind: 'task-notification' },
    })

  await notify('running')

  expect(await paneTexts($)).toContain('└ ● shell · Run the long test job · under 1 min')

  await notify(' completed ')

  // Finished, with nothing open under it, the task folds away with its job.
  expect((await paneTexts($)).slice(-2)).toEqual(['▸ Write the report', '✓ 1 earlier, closed'])
})

test('work started by an agent the pane does not know still shows', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Run the suite', kind: 'step' })
  await $.tool.call({
    tool: 'Bash',
    command: 'make test',
    description: 'Run the long test job',
    run_in_background: true,
    ...({ agentId: 'agent-from-before' } as object),
  })

  expect(await paneTexts($)).toContain('└ ● shell · Run the long test job · under 1 min')
})

test('two results finishing together share neither the reminder nor its count', async ($, on) => {
  await boot($, on)
  await start($)

  for (let called = 0; called < 39; called += 1) {
    await read($)
  }

  const both = await Promise.all([read($), read($)])

  expect(both.filter(note => note !== '').length).toBe(1)
  expect(both.join('')).toContain('40 tool calls since the trail was last updated')
})

test('going back to a node that exists needs no kind; a new node does', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Background job plus subtract', kind: 'step' })
  await track($, { action: 'leave', as: 'open' })

  expect(await track($, { action: 'enter', title: 'Background job plus subtract' })).toContain(
    'Session › Background job plus subtract',
  )
  expect(await track($, { action: 'enter', title: 'Something new' })).toContain(
    'needs kind "step" or "detour" for a new node',
  )
})

test('a fork hangs under its task while that task is open; the rest stand in two groups: to decide, and noted', async ($, on) => {
  const clock = await boot($, on)

  await command($, '')
  await track($, { action: 'enter', title: 'Add retry fix', kind: 'step' })
  await track($, { action: 'next', title: 'Review the changed rows' })
  await clock.advance(5 * MINUTE)

  expect(
    await track($, {
      action: 'park',
      titles: ['Decide: merge the cache branch', 'Trailing spaces in config keys, unchecked'],
    }),
  ).toContain('Parked: [p4] Decide: merge the cache branch (to decide); [p5] Trailing spaces in config keys, unchecked')

  // A fork that comes up again is already on the list.
  await track($, { action: 'park', title: 'decide: merge the cache branch' })
  await track($, { action: 'leave', outcome: 'all rows reviewed' })
  await clock.advance(MINUTE)

  expect(await paneTexts($)).toEqual([
    'NOW   Session',
    '      between tasks',
    'OPEN  2 forks open, 1 for you to decide · 1 unfinished',
    ' ',
    '◌ Add retry fix (left open) [n2]',
    'FOR YOU TO DECIDE',
    '└ ? merge the cache branch [p4]',
    'NOTED, NOT DONE',
    '└ · Trailing spaces in config keys, unchecked [p5]',
    '✓ 1 earlier, closed',
  ])
  expect(await track($, { action: 'park' })).toContain('needs a title')

  // Taken up by its id, the fork leaves the list and becomes the task.
  await track($, { action: 'enter', title: 'p4', kind: 'step' })

  expect(await paneTexts($)).toEqual([
    'NOW   Decide: merge the cache branch',
    '      in progress · under 1 min',
    'OPEN  1 fork open · 1 unfinished',
    ' ',
    '◌ Add retry fix (left open) [n2]',
    '▸ Decide: merge the cache branch',
    'NOTED, NOT DONE',
    '└ · Trailing spaces in config keys, unchecked [p5]',
    '✓ 1 earlier, closed',
  ])
})

test('a task ending shows the open forks, and several are closed in one call', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Build the guard', kind: 'step' })
  await track($, { action: 'park', titles: ['Old requests hit the cache twice', 'Decide: merge the cache branch', 'Four more tests'] })

  expect(await track($, { action: 'leave', outcome: 'guard built' })).toContain(
    'Open under what you left, unpark what it settled: [p3] Old requests hit the cache twice; [p4] Decide: merge the cache branch (to decide); [p5] Four more tests',
  )
  expect(await track($, { action: 'unpark', titles: ['p3', 'p5', 'p9'] })).toContain('1 parked')
  expect(await track($, { action: 'unpark', titles: ['p9'] })).toContain('no parked item «p9»')

  // A parked fork is taken up by its id without saying a kind.
  expect(await track($, { action: 'enter', title: 'p4' })).toContain('Session › Decide: merge the cache branch')
  expect(await track($, { action: 'leave', outcome: 'pushed' })).not.toContain('Open under')
})

test('asked what is open, Claude reads the whole tree with its ids', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Add retry fix', kind: 'step' })
  await track($, { action: 'park', title: 'Trailing spaces in config keys, unchecked' })
  await track($, { action: 'leave', as: 'open' })

  expect(await track($, { action: 'show' })).toBe(
    [
      '▸ Session [n1] ← here',
      '  ◌ Add retry fix [n2] (left open)',
      'Parked:',
      '  · Trailing spaces in config keys, unchecked [p3] (from: Add retry fix)',
    ].join('\n'),
  )
})

test('a press opens a fork up: where it came from, take up and drop; nothing is sent', async ($, on) => {
  const kept = new Map<string, unknown>()

  await boot($, on, undefined, kept)
  await command($, '')
  await track($, { action: 'enter', title: 'Add index migration', kind: 'step' })
  await track($, { action: 'park', titles: ['Decide: apply the index migration on staging', 'Trailing spaces in config keys'] })
  await track($, { action: 'leave', as: 'open' })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = () => rowsOf(pane)
  const press = async (text: RegExp) => pane.press({ key: (await pane.find({ type: 'Button', text }))?.key ?? '' })

  await press(/Decide: apply the index/)

  expect(tree(await rows())).toEqual([
    '◌ Add index migration (left open) [n2]',
    '├ ▾ Decide: apply the index migration on staging [p3]',
    '│   raised under 1 min ago',
    '│   take up  drop',
    '└ · Trailing spaces in config keys [p4]',
  ])

  // take up: the fork goes into the prompt box, the person sends it.
  await press(/^take up$/)

  expect(filled).toEqual([{ text: 'do p3: Decide: apply the index migration on staging', mode: 'replace' }])
  expect((await rows()).some(row => row.includes('take up'))).toBe(false)

  // Into a draft already begun it goes as a reference.
  draft = 'explain '
  await press(/Trailing spaces/)
  await press(/^take up$/)

  expect(filled[1]).toEqual({ text: 'p4 (Trailing spaces in config keys) ', mode: 'insert' })

  // drop: off the list at once, saved, and said in a toast.
  await press(/Trailing spaces/)
  await press(/^drop$/)
  await press(/Add index migration \(left open\)/)

  expect(tree(await rows())).toEqual([
    '▾ Add index migration (left open) [n2]',
    '  left unfinished · under 1 min ago',
    '  take up  drop',
    '└ ? Decide: apply the index migration on staging [p3]',
  ])

  await press(/^drop$/)
  await pane.unmount()

  expect(toasted).toEqual([
    'Trail: dropped p4 «Trailing spaces in config keys»',
    'Trail: dropped n2 «Add index migration»',
  ])
  expect(await paneTexts($)).toEqual([
    'NOW   Session',
    '      between tasks',
    'OPEN  1 fork open, 1 for you to decide',
    ' ',
    'FOR YOU TO DECIDE',
    '└ ? apply the index migration on staging [p3]',
    '✓ 1 earlier, closed',
  ])
  expect((kept.get('trail:S1') as Trail).parked.filter(item => item.isOpen).map(item => item.id)).toEqual(['p3'])
  expect(kicked).toEqual([])
})

test('a fork parked right after its task was left still belongs to that task', async ($, on) => {
  await boot($, on)
  await command($, '')
  await $.turn.start({ text: 'run the checks', turnId: 't1' })
  await track($, { action: 'enter', title: 'Run the static checks', kind: 'step' })
  await track($, { action: 'leave', outcome: 'all three clean' })
  await track($, { action: 'park', title: 'Three findings in untouched files' })

  // The next turn starts between tasks: a fork raised there belongs to the session.
  await $.turn.start({ text: 'ok', turnId: 't2' })
  await track($, { action: 'park', title: 'Two backup branches to delete later' })

  // The task is finished and folds; both forks stand on their own, and the first still knows its task.
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.press({ key: (await pane.find({ type: 'Button', text: /Three findings/ }))?.key ?? '' })

  expect(tree(await rowsOf(pane))).toEqual([
    'NOTED, NOT DONE',
    '├ ▾ Three findings in untouched files [p3]',
    '│   from «Run the static checks» · raised under 1 min ago',
    '│   take up  drop',
    '└ · Two backup branches to delete later [p4]',
    '✓ 1 earlier, closed',
  ])
  await pane.unmount()
})

test('a fork is filed where it belongs: under the session, under another task, or moved there later', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Static checks', kind: 'step' })
  await track($, { action: 'leave', outcome: 'clean' })
  await $.turn.start({ text: 'review', turnId: 't2' })
  await track($, { action: 'enter', title: 'Review of commits 6 and 7', kind: 'step' })
  await track($, {
    action: 'park',
    titles: ['Decide: keep or drop the old parser', 'Decide: merge the cache and index branches', 'Three findings in untouched files'],
  })

  // Not about the review: a standing decision goes to the session, a finding to the task it came out of.
  await track($, { action: 'park', title: 'p5', under: 'session' })
  await track($, { action: 'park', title: 'p6', under: 'n2' })
  await track($, { action: 'park', title: 'Decide: apply the index on staging', under: 'Session' })

  expect(await track($, { action: 'park', title: 'p4', under: 'n99' })).toContain('no task «n99» to park under')
  expect(tree(await paneTexts($))).toEqual([
    '▸ Review of commits 6 and 7',
    '└ ? Decide: keep or drop the old parser [p4]',
    'FOR YOU TO DECIDE',
    '├ ? merge the cache and index branches [p5]',
    '└ ? apply the index on staging [p7]',
    'NOTED, NOT DONE',
    '└ · Three findings in untouched files [p6]',
    '✓ 1 earlier, closed',
  ])
})

test('a press on the row of folded closed tasks shows them, a second press folds them again', async ($, on) => {
  await boot($, on)
  await command($, '')

  for (const title of ['one', 'two', 'three', 'four', 'five']) {
    await track($, { action: 'enter', title: `Task ${title}`, kind: 'step' })
    await track($, { action: 'leave', outcome: 'done' })
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const press = async () => pane.press({ key: (await pane.find({ type: 'Button', text: /earlier, closed/ }))?.key ?? '' })

  expect(tree(await rowsOf(pane))).toEqual(['✓ 5 earlier, closed'])

  await press()

  expect(tree(await rowsOf(pane))).toEqual([
    '▾ 5 earlier, closed',
    '✓ Task one',
    '✓ Task two',
    '✓ Task three',
    '✓ Task four',
    '✓ Task five',
  ])

  await press()
  await pane.unmount()

  expect(await paneTexts($)).toContain('✓ 5 earlier, closed')
})

test('a pane of its own opens only when asked for; docked, it takes the tree over from the band until it closes', async ($, on) => {
  await boot($, on)
  isPanePlaced = true
  await command($, '')
  await track($, { action: 'enter', title: 'Static checks', kind: 'step' })

  // Turning the trail on opened nothing: the tree is the band's.
  expect(askedRows).toEqual([])
  expect(await rowsOf(await $.ui.mount({ ...BAND, surface: 'terminal', viewport: { columns: 120, rows: 60 } }))).toEqual([
    'Trail',
    '▸ Static checks',
  ])

  // Asked for, the pane wants a sixth of the 60-row screen where it is seated above the prompt.
  expect(await command($, 'pane')).toContain('Trail pane opened')
  expect(askedRows).toEqual([10])

  // Seated above the prompt it stands beside the band, which keeps the tree.
  const inline = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' } })

  expect(await rowsOf(inline)).toEqual(['▸ Static checks'])
  await inline.unmount()
  expect(await rowsOf(await $.ui.mount({ ...BAND, surface: 'terminal' }))).toEqual(['Trail', '▸ Static checks'])

  // Docked beside the transcript it is the tree; the band has nothing left to say here.
  await (await $.ui.mount({ ...PANE, surface: 'terminal' })).unmount()

  const beside = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await beside.find({ text: 'nothing drawn' })).toBeDefined()

  // Closed, the tree is the band's again.
  expect(await command($, 'close')).toContain('The tree stands above the prompt')
  expect(await rowsOf(await $.ui.mount({ ...BAND, surface: 'terminal' }))).toEqual(['Trail', '▸ Static checks'])
  isPanePlaced = false
})

test('Claude says outright which forks wait for the person; the wording does not decide it', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, {
    action: 'park',
    titles: ['Trailing spaces in config keys', 'Accept the two new test cases'],
    decide: ['Reword the error message or leave it'],
  })

  // A fork noted as a plain one turns out to be the person's call: its id in "decide" says so.
  expect(await track($, { action: 'park', decide: ['p3'] })).toContain(
    '[p3] Accept the two new test cases (to decide)',
  )
  expect(tree(await paneTexts($))).toEqual([
    'FOR YOU TO DECIDE',
    '├ ? Accept the two new test cases [p3]',
    '└ ? Reword the error message or leave it [p4]',
    'NOTED, NOT DONE',
    '└ · Trailing spaces in config keys [p2]',
  ])
  expect(await track($, { action: 'show' })).toContain('  ? Reword the error message or leave it [p4]')
  expect(await track($, { action: 'park' })).toContain('needs a title')
})

test('a job stopped by hand is no longer shown as running', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Full build at the tip', kind: 'step' })
  await $.tool.call({ tool: 'Bash', command: 'run.sh', description: 'Run all ten build steps', run_in_background: true })

  expect(await paneTexts($)).toContain('└ ● shell · Run all ten build steps · under 1 min')

  await $.tool.call({ tool: 'TaskStop', task_id: 'bash-1' })
  await track($, { action: 'leave', as: 'dropped', outcome: 'stopped half way' })

  // Stopped and its task given up: nothing of it stays in view.
  expect(tree(await paneTexts($))).toEqual(['✓ 1 earlier, closed'])
})

test('a job whose end went unheard is not called running after its task was given up', async ($, on) => {
  const kept = new Map<string, unknown>()

  await boot($, on, undefined, kept)
  await command($, '')
  await track($, { action: 'enter', title: 'Full build at the tip', kind: 'step' })
  await $.tool.call({ tool: 'Bash', command: 'run.sh', description: 'Run all ten build steps', run_in_background: true })
  await track($, { action: 'leave', as: 'dropped', outcome: 'stopped half way' })

  expect(tree(await paneTexts($))).toContain('└ ● shell · Run all ten build steps · under 1 min')

  // The next load of the mod looks again.
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  expect(tree(await paneTexts($))).toEqual(['✓ 1 earlier, closed'])
  expect((kept.get('work:S1') as { state: string }[]).map(item => item.state)).toEqual(['unknown'])
})

test('where no pane docks, the tree stands in the band above the prompt, cut to a few rows until more is asked for', async ($, on) => {
  await boot($, on)
  await command($, '')

  for (const title of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']) {
    await track($, { action: 'park', title: `Fork ${title}` })
  }

  const INLINE = { ...BAND, surface: 'terminal', viewport: { columns: 120, rows: 48, isFullscreen: false } } as const
  const band = await $.ui.mount(INLINE)
  const press = async (text: RegExp) => band.press({ key: (await band.find({ type: 'Button', text }))?.key ?? '' })

  // 48 rows of screen: eight for the tree. The whole tree would not fit, so the strip stands
  // there instead: the forks newest first, one row each, and the last row says what is left out.
  // The first row is the frame's title and the counts, side by side.
  expect(await rowsOf(band)).toEqual([
    'Trail9 forks open',
    '· Fork nine [p10] · under 1 min',
    '· Fork eight [p9] · under 1 min',
    '· Fork seven [p8] · under 1 min',
    '· Fork six [p7] · under 1 min',
    '· Fork five [p6] · under 1 min',
    '· Fork four [p5] · under 1 min',
    '· Fork three [p4] · under 1 min',
    '▾ 2 more noted',
  ])

  await press(/2 more noted/)

  expect((await rowsOf(band)).slice(-3)).toEqual(['├ · Fork eight [p9]', '└ · Fork nine [p10]', '▴ show fewer'])

  // The rows are pressable here as in the pane.
  await press(/Fork nine/)

  expect((await rowsOf(band)).slice(-4)).toEqual([
    '└ ▾ Fork nine [p10]',
    '    raised under 1 min ago',
    '    take up  drop',
    '▴ show fewer',
  ])

  await press(/show fewer/)
  await band.unmount()

  // No second box beside it: /trail opens no pane in this layout.
  askedRows = []
  expect(await command($, '')).toContain('The tree stands above the prompt')
  expect(askedRows).toEqual([])
})

test('one call closes a task and files what it leaves behind; other forks are only counted', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'park', title: 'Two backup branches to delete later' })
  await track($, { action: 'enter', title: 'Static checks', kind: 'step' })

  expect(
    await track($, {
      action: 'leave',
      outcome: 'all three clean',
      titles: ['Three findings in untouched files'],
      decide: ['Merge the cache branch'],
    }),
  ).toBe(
    [
      'Session (1/1 steps · 3 parked)',
      'Open under what you left, unpark what it settled: [p4] Three findings in untouched files; [p5] Merge the cache branch (to decide)',
      '1 other fork open; action "show" lists them.',
    ].join('\n'),
  )
  expect(tree(await paneTexts($))).toEqual([
    'FOR YOU TO DECIDE',
    '└ ? Merge the cache branch [p5]',
    'NOTED, NOT DONE',
    '├ · Two backup branches to delete later [p2]',
    '└ · Three findings in untouched files [p4]',
    '✓ 1 earlier, closed',
  ])
})

test('the note rides a prompt only when it says something new', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Static checks', kind: 'step' })

  expect(await prompt($)).toBe('[trail] Session › Static checks (0/1 steps)')
  expect(await prompt($)).toBe('')

  // Three prompts without a report: said once, and not again with every prompt after it.
  expect(await prompt($)).toContain('has not been updated for 3 prompts')
  expect(await prompt($)).toBe('')

  // The path changed: said again.
  await track($, { action: 'leave', as: 'open' })

  expect(await prompt($)).toBe('[trail] Session (0/1 steps · 1 left open)\nLeft open, continue by id: [n2] Static checks')
  expect(await prompt($)).toBe('')
})

test('what the model is shown of the tree leaves the finished branches out unless it asks for all', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Static checks', kind: 'step' })
  await track($, { action: 'leave', outcome: 'all three clean', titles: ['Three findings in untouched files'] })
  await track($, { action: 'enter', title: 'Rename the field', kind: 'step' })

  expect(await track($, { action: 'show' })).toBe(
    [
      '▸ Session [n1]',
      '  ▸ Rename the field [n4] ← here',
      '(1 finished branch is left out)',
      'Parked:',
      '  · Three findings in untouched files [p3] (from: Static checks)',
    ].join('\n'),
  )
  expect(await track($, { action: 'show', title: 'all' })).toContain('  ✓ Static checks [n2] (all three clean)')
})

test('a job started between tasks is shown while it runs and not after', async ($, on) => {
  await boot($, on)
  await command($, '')
  await $.tool.call({
    tool: 'Bash',
    command: 'sleep 600',
    description: 'Wait for the build to end',
    run_in_background: true,
  })

  expect(tree(await paneTexts($))).toEqual(['● shell · Wait for the build to end · under 1 min'])

  await $.prompt.submit({
    text: '<task-notification>\n<task-id>bash-1</task-id>\n<status>completed</status>\n</task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
  })

  expect(await paneTexts($)).not.toContain('✓ shell · Wait for the build to end · done after under 1 min')
  expect((await paneTexts($)).some(row => row.includes('Wait for the build'))).toBe(false)
})

test('a watch ends on the notice that it expired, not on one of its events', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Review the plan', kind: 'step' })
  await $.tool.call({
    tool: 'Monitor',
    command: 'tail -F review.log | grep --line-buffered done',
    description: 'Codex review: done',
    timeout_ms: 1_800_000,
  })

  const event = (body: string) =>
    notice($, `<task-id>mon-1</task-id>\n<summary>Monitor event: "Codex review: done"</summary>\n<event>${body}</event>`)

  // An event is news from the watch, not its end: no status rides with it.
  await event('[codex] Reconnecting')

  expect(await paneTexts($)).toContain('└ ● monitor · Codex review: done · under 1 min')

  await event('[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]')

  expect(await paneTexts($)).toContain('└ ✓ monitor · Codex review: done · done after under 1 min')
})

test('one notice ends every job it names; stopped is an end; the engine\'s markers are not jobs', async ($, on) => {
  const kept = new Map<string, unknown>()

  await boot($, on, undefined, kept)
  await command($, '')
  await track($, { action: 'enter', title: 'Two nights on a copy', kind: 'step' })
  await $.tool.call({ tool: 'Bash', command: 'night.sh 1', description: 'Night one', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'night.sh 2', description: 'Night two', run_in_background: true })

  await notice(
    $,
    '<task-id>bash-1</task-id>\n<task-id>bash-2</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>2 background shell commands didn\'t finish before the previous session ended</summary>',
  )

  const rows = await paneTexts($)

  expect(rows).toContain('├ ✗ shell · Night one · stopped after under 1 min')
  expect(rows).toContain('└ ✗ shell · Night two · stopped after under 1 min')
  expect((kept.get('work:S1') as { id: string }[]).map(item => item.id)).toEqual(['bash-1', 'bash-2'])
})

test('an agent that ends takes the jobs it started into the unknown; a late notice still lands', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Run the pilot', kind: 'step' })
  await spawn($, 'pilot')
  await $.tool.call({
    tool: 'Bash',
    command: 'judge.sh 1',
    description: 'Judge batch one',
    run_in_background: true,
    ...({ agentId: 'agent-pilot' } as object),
  })

  expect((await paneTexts($)).some(row => row.includes('● shell · Judge batch one · under 1 min'))).toBe(true)

  // The shell's end was told to the agent; the agent is gone, so nobody here will hear it.
  await finish($, 'agent-pilot')

  const rows = await paneTexts($)

  expect(rows.some(row => row.includes('✓ agent · Explore: pilot · done after under 1 min'))).toBe(true)
  expect(rows.some(row => row.includes('? shell · Judge batch one · unknown'))).toBe(true)

  // Should the notice reach the main conversation after all, it is the truth and replaces the guess.
  await notice($, '<task-id>bash-1</task-id>\n<status>completed</status>')

  expect((await paneTexts($)).some(row => row.includes('✓ shell · Judge batch one · done after under 1 min'))).toBe(true)
})

test('a teammate that answered only waits, and what it started keeps running', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Judge the pairs', kind: 'step' })
  await spawn($, 'batch', { isTeammate: true })
  await $.tool.call({
    tool: 'Bash',
    command: 'judge.sh',
    description: 'Judge batch two',
    run_in_background: true,
    ...({ agentId: 'agent-batch' } as object),
  })
  await finish($, 'agent-batch')

  const rows = await paneTexts($)

  expect(rows.some(row => row.includes('◌ teammate · teammate: batch · idle after under 1 min'))).toBe(true)
  expect(rows.some(row => row.includes('● shell · Judge batch two · under 1 min'))).toBe(true)
})

test('a watch that ran past the longest allowed is unknown once the turn ends', async ($, on) => {
  const clock = await boot($, on)

  await command($, '')
  await track($, { action: 'enter', title: 'Wait for the night', kind: 'step' })
  await $.tool.call({ tool: 'Monitor', command: 'tail -F night.log', description: 'Night: phases and failures', timeout_ms: 1_800_000 })
  await clock.advance(31 * MINUTE)

  expect(await paneTexts($)).toContain('└ ● monitor · Night: phases and failures · 31 min')

  await finish($)

  expect(await paneTexts($)).toContain('└ ? monitor · Night: phases and failures · unknown')
})

test('an agent the engine still lists as ended is not live: what it started goes unknown at the turn\'s end', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Run the pilot', kind: 'step' })
  await spawn($, 'pilot')
  await spawn($, 'scout')
  await $.tool.call({
    tool: 'Bash',
    command: 'judge.sh 1',
    description: 'Judge batch one',
    run_in_background: true,
    ...({ agentId: 'agent-pilot' } as object),
  })
  await $.tool.call({
    tool: 'Bash',
    command: 'scan.sh',
    description: 'Scan the goods',
    run_in_background: true,
    ...({ agentId: 'agent-scout' } as object),
  })

  // The pilot's end was never heard here, but the engine's list says it: completed. The scout still runs.
  listed = [
    { id: 'agent-pilot', description: 'pilot', type: 'Explore', status: 'completed' },
    { id: 'agent-scout', description: 'scout', type: 'Explore', status: 'running' },
  ]
  await finish($)

  const rows = await paneTexts($)

  expect(rows.some(row => row.includes('? agent · Explore: pilot · unknown'))).toBe(true)
  expect(rows.some(row => row.includes('? shell · Judge batch one · unknown'))).toBe(true)
  expect(rows.some(row => row.includes('● agent · Explore: scout · under 1 min'))).toBe(true)
  expect(rows.some(row => row.includes('● shell · Scan the goods · under 1 min'))).toBe(true)
})

/** The id of the one fork a park result names. */
const parkedId = (result: string) => /\[(p\d+)\]/.exec(result)?.[1] ?? ''

test('a call that closes a task also settles the forks it names, and says which were not waiting', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Push the pair', kind: 'step' })

  const id = parkedId(await track($, { action: 'park', decide: ['Say the word: push the pair'] }))
  const out = await track($, { action: 'leave', outcome: 'pair pushed', settled: [id, 'p99'] })

  expect(out).toContain(`Settled: [${id}] Say the word: push the pair`)
  expect(out).toContain('Not waiting, skipped: p99')
  expect(await track($, { action: 'show' })).not.toContain('Say the word')
})

test('"settled" refuses a malformed list and leaves the trail as it was', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Push the pair', kind: 'step' })

  const id = parkedId(await track($, { action: 'park', decide: ['Say the word: push the pair'] }))

  expect(await track($, { action: 'leave', outcome: 'pushed', settled: id })).toContain('takes a list of fork ids')
  expect(await track($, { action: 'unpark', title: id, settled: [id] })).toContain('goes with park, leave or next')
  expect(await track($, { action: 'confirm' })).toContain('Session › Push the pair')
  expect(await track($, { action: 'show' })).toContain('Say the word: push the pair')
})

test('a fork cannot be settled and filed in one call', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Push the pair', kind: 'step' })

  const id = parkedId(await track($, { action: 'park', decide: ['Push the pair now'] }))

  expect(await track($, { action: 'park', settled: [id], decide: ['Push the pair now'] })).toContain(
    'is both settled and filed in this call',
  )
  expect(await track($, { action: 'next', title: id, settled: [id] })).toContain('is both settled and filed in this call')
  expect(await track($, { action: 'show' })).toContain('Push the pair now')
})

test('the note lists the decisions waiting, newest first, and comes again when they change', async ($, on) => {
  const clock = await boot($, on)

  await command($, '')
  await track($, { action: 'enter', title: 'Build the index', kind: 'step' })
  await track($, { action: 'park', decide: ['Rebuild from nothing, yes or no'] })

  expect(await prompt($)).toContain(
    'Decisions waiting, settle by id what is taken: [p3] Rebuild from nothing, yes or no',
  )
  expect(await prompt($)).toBe('')

  await clock.advance(MINUTE)
  await track($, { action: 'park', decide: ['Keep the old index around'] })

  expect(await prompt($)).toContain('[p4] Keep the old index around; [p3] Rebuild from nothing, yes or no')
})

test('a call that adds a decision answers with the other decisions waiting', async ($, on) => {
  const clock = await boot($, on)

  await command($, '')
  await track($, { action: 'enter', title: 'Build the index', kind: 'step' })

  // The first decision has none before it to replace: nothing is named.
  expect(await track($, { action: 'park', decide: ['Rebuild from nothing, yes or no'] })).not.toContain(
    'Decisions waiting',
  )

  await clock.advance(MINUTE)

  const out = await track($, { action: 'leave', outcome: 'index built', decide: ['Keep the old index around'] })

  expect(out).toContain('Decisions waiting, settle by id what is taken: [p3] Rebuild from nothing, yes or no\n')
  // A plain closing names nothing of the kind.
  expect(await track($, { action: 'enter', title: 'Ship it', kind: 'step' })).not.toContain('Decisions waiting')
})

test('a new task goes under the root while another is open, and the one left open is named', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Synonym builder loop', kind: 'step' })

  const out = await track($, { action: 'enter', title: 'Four unify commits: decide', kind: 'step' })

  expect(out).toContain('Session › Four unify commits: decide')
  expect(out).toContain('Left open: [n2] Synonym builder loop. Continue it by id')
  expect(await track($, { action: 'show' })).toContain('Synonym builder loop [n2] (left open)')
  // Back to it by id: nothing was lost.
  expect(await track($, { action: 'enter', title: 'n2' })).toContain('Session › Synonym builder loop')
})

test('a step of the task at hand is placed there with "under"; a detour and a step inside it stay with the cursor', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'Builder loop', kind: 'step' })

  expect(await track($, { action: 'enter', title: 'Score the builder', kind: 'step', under: 'n2' })).toContain(
    'Session › Builder loop › Score the builder',
  )
  expect(await track($, { action: 'enter', title: 'DB down', kind: 'detour' })).toContain(
    'Session › Builder loop › Score the builder › DB down',
  )
  expect(await track($, { action: 'enter', title: 'Restart the DB', kind: 'step' })).toContain(
    'Session › Builder loop › Score the builder › DB down › Restart the DB',
  )
})

test('a title that names two open nodes is refused with their ids; a child of the task at hand is taken first', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'A', kind: 'step' })
  await track($, { action: 'plan', steps: ['tests'] })
  await track($, { action: 'enter', title: 'B', kind: 'step' })
  await track($, { action: 'plan', steps: ['tests'] })

  // Under B, "tests" is B's planned step.
  expect(await track($, { action: 'enter', title: 'tests' })).toContain('Session › B › tests')

  await track($, { action: 'leave', as: 'open' })
  await track($, { action: 'leave', as: 'open' })

  // At the root both are open and neither is nearer: no guess.
  expect(await track($, { action: 'enter', title: 'tests' })).toContain(
    '«tests» names 2 open nodes: [n3] under n2, [n5] under n4. Enter one by its id.',
  )
  expect(await track($, { action: 'enter', title: 'n3' })).toContain('Session › A › tests')
})

test('next resolves its target before it commits: an ambiguous target leaves the task as it was', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'A', kind: 'step' })
  await track($, { action: 'plan', steps: ['tests'] })
  await track($, { action: 'enter', title: 'B', kind: 'step' })
  await track($, { action: 'plan', steps: ['tests'] })

  expect(await track($, { action: 'next', title: 'tests', outcome: 'planned' })).toContain('names 2 open nodes')
  // B is still the task at hand, not closed by the refused call.
  expect(await track($, { action: 'confirm' })).toContain('Session › B')
  expect(await track($, { action: 'show' })).not.toContain('planned')
})

test('a picked-up fork becomes a task under its home while that is unfinished, else under the root', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'A', kind: 'step' })

  const inA = parkedId(await track($, { action: 'park', title: 'Check the index' }))

  await track($, { action: 'leave', as: 'open' })

  expect(await track($, { action: 'enter', title: inA })).toContain('Session › A › Check the index')

  await track($, { action: 'leave', outcome: 'checked' })
  await track($, { action: 'leave', outcome: 'done with A' })
  await track($, { action: 'enter', title: 'C', kind: 'step' })

  const inC = parkedId(await track($, { action: 'park', title: 'Later thing' }))

  await track($, { action: 'leave', outcome: 'done with C' })

  // C is finished: its fork, picked up, is a task of its own.
  expect(await track($, { action: 'enter', title: inC })).toContain('Session › Later thing')
})

test('"under" must name a task not finished, and a node that exists keeps its place', async ($, on) => {
  await boot($, on)
  await command($, '')
  await track($, { action: 'enter', title: 'A', kind: 'step' })

  expect(await track($, { action: 'enter', title: 'X', kind: 'step', under: 'n99' })).toContain('no open task «n99»')

  await track($, { action: 'leave', outcome: 'done' })

  expect(await track($, { action: 'enter', title: 'Y', kind: 'step', under: 'n2' })).toContain('no open task «n2»')

  await track($, { action: 'enter', title: 'B', kind: 'step' })
  await track($, { action: 'enter', title: 'C', kind: 'step', under: 'n3' })

  expect(await track($, { action: 'enter', title: 'n4', under: 'session' })).toContain('already has its place')
  expect(await track($, { action: 'confirm' })).toContain('Session › B › C')
})
