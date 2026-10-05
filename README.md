# trail

## The problem

A long session with a coding agent leaves loose ends, and they get lost.

You ask for one thing. On the way the agent notices something else and says
"I saw this, I left it alone". It finishes and adds "two options, your call".
You answer "ok" and ask for the next thing. Three hours later there are a dozen
of these: things noticed and never looked at, offers never taken up, decisions
still waiting for your word, a task that was started and overtaken. They are
all in the conversation, far up, where nobody scrolls.

Nothing was done wrong at any single step. The work was simply never told
"this is still open", so it forgot.

## What this does

trail is a Claude Code mod that keeps that list in view. Above the prompt it
shows what is open right now: the task being worked on, tasks left unfinished,
and every loose end, sorted into the ones that wait for **your decision** and
the ones that were only **noted**.

```
╭─ Trail ──────────────────── 3 forks open, 1 for you to decide ─ [-]
│ ▸ Speed up the import                                              │
│ └ ○ Add a benchmark                                                │
│ FOR YOU TO DECIDE                                                  │
│ └ ? merge the cache branch [p38]                                   │
│ NOTED, NOT DONE                                                    │
│ ├ · Trailing spaces in five config keys, unchecked [p15]           │
│ └ · Three old branches to delete later [p58]                       │
│ ✓ 10 earlier, closed                                               │
╰────────────────────────────────────────────────────────────────────╯
```

A loose end is called a **fork** here: a point where the work could have gone
somewhere and did not. Claude notes each fork at the moment it writes it into
its answer, and takes it off the list when it is settled. You pick one up with
a click, or by typing its id: `do p15`, `drop p38`.

It is off until you type `/trail`, and Claude's bookkeeping draws nothing in
the conversation.

## What it shows

| Mark | Meaning |
|---|---|
| `▸` | the task being worked on |
| `◌` | a task that was started and left unfinished |
| `○` | a planned step not started yet |
| `?` | a fork that waits for your word: a decision, a go, an answer |
| `·` | a fork that was noticed or offered and left |
| `●` | a background job still running under its task |
| `✓ N earlier, closed` | everything finished, folded into one row |

- A fork hangs under its task while that task is open. Once the task is
  finished it folds into the closed row, and its forks stand in one of two
  groups: **FOR YOU TO DECIDE** and **NOTED, NOT DONE**.
- The top edge carries the counts of what is still open. What is done is not
  counted.
- The strip takes about a sixth of the screen. `▾ N more` shows the rest,
  `▴ show fewer` cuts it back.

## Using it

| You do | What happens |
|---|---|
| `/trail` | turns the trail on for this session |
| `/trail off` | turns it off and forgets the tree |
| `[-]` at the top right, or `ctrl+x ctrl+a` | folds the strip away and shows it again |
| click a fork, or `ctrl+x` `Tab`, `Tab` to it, `Enter` | opens it: where it came from, **take up**, **drop** |
| click `✓ N earlier, closed` | shows the finished tasks, and hides them again |
| type `do p15`, `drop p38`, `which forks are open` | Claude reads the tree and acts on the ids |

**take up** puts `do p15: <title>` into the prompt box; nothing is sent until
you press Enter. **drop** takes the fork off the list at once.

Other commands: `/trail text` prints the whole tree with ids, `/trail pane`
opens the tree as a pane of its own (it docks at the side in a wide
fullscreen terminal) and `/trail close` takes that away, `/trail park <text>`
and `/trail unpark <id>` add and remove a fork by hand, `/trail goal <text>`
names the session, `/trail back`, `/trail done [outcome]` and
`/trail drop [reason]` end the current task by hand, `/trail clear` starts a
fresh tree.

Mouse clicks need the fullscreen layout, which is the default outside tmux.

## How it works

Claude keeps the tree through one tool, `mcp__trail__track`: it enters a task
when it starts one, leaves it when it ends, and parks every fork in the turn it
raises it, saying whether the fork waits for you. The mod stores what Claude
reports and draws it; it does not read the conversation and invents nothing.
The rules reach Claude as hidden context when you type `/trail`, and one hidden
line rides each of your prompts with the current path.

So the tree is only as true as Claude's reports. In practice it adds and closes
forks by itself; a step done without being reported stays shown as not started.

The tree is saved per session and comes back after a restart and a `/clear`;
after a compaction Claude is given the whole tree again.

There is also a tripwire for side tracks (detours nested two deep, thirty
working minutes or five of your prompts in detours; the limits are in
`/config`). It tells Claude to stop and ask. On sessions made of many short
separate requests it never fires; the open forks are the point of this mod.

## Installing

Mods are function-hook plugins, an early-access feature of Claude Code; this
one was built on 2.1.289. Load the folder in every session by naming it in
`~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/trail" },
  "permissions": { "allow": ["mcp__trail__track"] }
}
```

or for one session with `claude --plugin-dir /path/to/trail`.

A session that loads the folder this way watches it: every saved change
reloads the mod and prints one line into that session. Keep a separate working
copy and copy finished changes over.

## Developing

```sh
claude plugin test .        # the tests
claude plugin validate .    # what the engine would refuse
tsc -p .                    # types; .claude-plugin/types is laid by the engine once the mod has loaded
```

To look at a change before it reaches your sessions, start a session that
loads the working copy instead of the installed one:

```sh
echo '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/path/to/working-copy"}}' > /tmp/dev-settings.json
claude --settings /tmp/dev-settings.json
```

| Path | What |
|---|---|
| `hooks/register.tsx` | the hooks: the tool, the `/trail` command, the strip, the pane |
| `hooks/model.ts` | the tree's logic and the rows of the drawing, without the engine |
| `types/index.d.ts` | the state the mod keeps |
| `tests/` | tests of the logic and of the hooks |
| `tools/` | `digest.py` and `replay.ts`: replay a past session's transcript through the logic, with a model labelling each turn; an estimate, not a measurement |

## Not verified

A real compaction, agents and forked agents shown under their task, and the
tripwire at its default limits have only been tested, not seen in a live
session.
