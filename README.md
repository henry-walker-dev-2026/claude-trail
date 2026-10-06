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
╭─ Trail ────────────────────── 3 forks open, 1 for you to decide [-]
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
- The strip takes about a sixth of the screen. While the whole tree fits, it is
  the tree. When it does not, the strip shows what matters most, one row each:
  the task at hand, then the decisions waiting, newest first, then tasks left
  open, then forks only noted, each with its id and its age, titles cut to the
  width. The last row counts what is left out (`▾ 9 more decisions, 71 more
  noted`) and opens the whole tree; `▴ show fewer` cuts it back.
- Opened whole, the tree comes in pages inside a box of fixed height (what the
  band allows, a sixth of the screen at least): `more ▸ 2/5` and `◂ back` turn
  them. The box never scrolls, so nothing jumps and the title row with the
  counts stays where it is.

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

Clicks need the fullscreen layout, see [Installing](#installing). In the
classic layout the `[-]` is drawn all the same but does nothing;
`ctrl+x ctrl+a` folds the strip in both.

## How it works

Claude keeps the tree through one tool, `mcp__trail__track`: it enters a task
when it starts one, leaves it when it ends, and parks every fork in the turn it
raises it, saying whether the fork waits for you. The mod stores what Claude
reports and draws it; it does not read the conversation and invents nothing.
The rules reach Claude as hidden context when you type `/trail`, and one hidden
note rides your prompts with the current path, the tasks left open and the
decisions waiting, with their ids, whenever any of that changed.

A new task goes under the root even while another is open: the one left open
is named in the tool's result and stays in the note until Claude continues it
by id or closes it. A step that belongs to the task at hand says so (`under`),
a detour stays with the cursor. A title that names two open nodes is refused
with both ids rather than guessed.

A fork that a call settles, a decision taken or an offer overtaken, is named by
id in `settled` on the same `park`, `leave` or `next` and closed in the same
change. The list is optional for now; `tools/settlement_audit.py` reads a
transcript and lists, for every call that added a decision, which decision ids
Claude had been shown before it and which it settled, for the audit that decides
whether optional is enough.

Background jobs show under the task they were started from. Their ends are
heard from the engine's notices: a status, a Monitor's expiry, every id a notice
names. A job started inside an agent that has ended or waits idle (its ends are told
to that agent, never here), and a Monitor older than the longest watch the
engine allows, are marked unknown rather than running; a notice that arrives
after all still sets the record straight.

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
  "tui": "fullscreen",
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/trail" },
  "permissions": { "allow": ["mcp__trail__track"] }
}
```

or for one session with `claude --plugin-dir /path/to/trail`.

trail needs the fullscreen layout. `"tui": "fullscreen"` sets it for every new
session, and `/tui fullscreen` switches a running one. Claude Code reads the
mouse only in that layout, so only there can you click `[-]`, a fork or the
closed row. In the classic layout (`"tui": "default"`) the strip is still
shown, but nothing in it reacts to a click and the keyboard is the only way to
use it.

Copying text works differently in the fullscreen layout: Claude Code does the
selecting itself and hands the text to your terminal's clipboard. Over SSH the
terminal has to allow that. In iTerm2 tick Settings → General → Selection →
"Applications in terminal may access clipboard". Without it a selection looks
fine but the clipboard keeps its old content. Holding Option while dragging
selects the way the terminal always did and copies in any case.

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
| `tools/` | `digest.py` and `replay.ts`: replay a past session's transcript through the logic, with a model labelling each turn; an estimate, not a measurement. `settlement_audit.py`: the settlement pilot's ledger from a transcript |
| `tests/fixtures/` | a synthetic twin of a real two-day session (same ids, shape, states and title lengths, titles replaced) that the strip is measured on |

## Not verified

Agents and forked agents shown under their task, and the tripwire at its
default limits, have only been tested, not seen in a live session. Compaction
has been seen live three times in one session; the tree came back each time.
Whether an optional `settled` list keeps the decision list true is the open
question: it is measured with `tools/settlement_audit.py` over a working
session, and the list becomes required if it does not.
