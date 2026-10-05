export type TrailKind = 'goal' | 'step' | 'detour'

/**
 * `open` with no `startedAt` is a planned step not begun; `open` with one is a
 * loose end: begun, then left without an outcome.
 */
export type TrailNodeState = 'open' | 'active' | 'done' | 'dropped'

export type TrailNode = {
  id: string
  kind: TrailKind
  title: string
  state: TrailNodeState
  parentId: string | null
  startedAt: number | null
  endedAt: number | null
  outcome: string | null
}

export type TrailParked = {
  id: string
  title: string
  fromId: string | null
  at: number
  isOpen: boolean
  /** Whether the fork waits for the person's word; absent on forks noted before this was said outright. */
  isAsk?: boolean
}

export type Trail = {
  nodes: TrailNode[]
  /** The node being worked on; null while no goal is set. */
  cursor: string | null
  parked: TrailParked[]
  seq: number
  /** Working minutes spent in detours since the main line was last touched. */
  detourMinutes: number
  /** The person's prompts spent in detours since the main line was last touched. */
  detourPrompts: number
  /** The person's prompts since the trail was last updated. */
  promptsSinceUpdate: number
  /** The tripwire fired on this detour episode; it fires once until the main line is touched again. */
  isTripped: boolean
}

export type TrailWorkState = 'running' | 'idle' | 'done' | 'failed' | 'stopped' | 'unknown'

/** One piece of parallel work: an agent, a fork, a teammate, or a background task. */
export type TrailWork = {
  id: string
  kind: 'agent' | 'fork' | 'teammate' | 'shell' | 'monitor' | 'workflow'
  title: string
  /** The trail node that was current when it started; null while no goal was set. */
  nodeId: string | null
  /** The agent whose loop started it; null from the main conversation. */
  parentId: string | null
  state: TrailWorkState
  startedAt: number
  endedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    trail: { trail: Trail; work: TrailWork[]; opened: string | null; unfolded: string[]; expanded: boolean }
  }

  interface McpToolInputs {
    mcp__trail__track: {
      action:
        | 'goal'
        | 'plan'
        | 'enter'
        | 'next'
        | 'leave'
        | 'park'
        | 'unpark'
        | 'confirm'
        | 'fix'
        | 'show'
      title?: string
      kind?: 'step' | 'detour'
      steps?: string[]
      titles?: string[]
      under?: string
      decide?: string[]
      outcome?: string
      as?: 'done' | 'dropped' | 'open'
    }
  }
}
