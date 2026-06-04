# Post-review roadmap

A plain-English plan built from the external AI review of sprint-helper (2026-06-04).
This is a **map, not a contract** — order and scope can change. Each detailed build plan
gets written later, per item, once the decisions below are made.

The one thing that ties everything together: **sprint-helper is becoming an installable
tool for other solo developers** — not a Moran-only cockpit, and not a multi-user product
with logins. Most of the work below matters *because* of that choice.

---

## Already done

- **Capacity comment fixed** (commit `f1e9f39`) — the stale "tentative × 0.5" note now
  matches the real behaviour (tentative meetings ignored entirely).
- **Typecheck cleared** (commit `85db4cb`) — the two long-standing errors are gone, so
  `npm run typecheck` passes cleanly and is trustworthy as a check again.
- **Rule 3 — standup summary required** (commit `cb106c0`) — progress/blocker logs are
  refused without the one-line summary.
- **Rules 2 + 1 — session-close checks** (commit `913db7c`) — honest remaining on pause,
  and a catch-up log/summary for sessions open >45 min with nothing recorded.
  *(All three rules need an MCP restart to take effect; not yet verified live.)*
- **Match the locks** (commit `25ec405`) — the dashboard "done" button now asks how many
  hours the task took and closes through the same hours-capturing path the AI uses; the
  edit route refuses to change Original Estimate after a task exists.
  *(Needs a dashboard hard-refresh to see; close-flow not yet verified in the browser.)*
- **Tool descriptions trimmed** (commit `e93d1a2`) — shortened the four bloated per-tool
  blurbs (and corrected a stale capacity one); the rest were already lean and the big
  rulebook was left untouched on purpose.

---

## Decisions made (2026-06-04) — all three settled

1. **Azure CLI vs direct API → support BOTH, chosen by config.** Build one internal doorway
   to Azure DevOps with two implementations behind it (CLI and direct API); a setting picks
   which, at install or later. Some installers won't have the CLI, so the tool can't assume
   it. Unblocks the "server runs reliably elsewhere" half of installation.
2. **Tests → yes, invest.** Start with the pure-math files, then the six invariants in
   Theme C. Runner: Vitest (natural fit for a Vite project) unless you object.
3. **Behaviour-rules to turn into code → harden 1, 2, 3; leave 4 as prose.**
   - *Harden (do first):* require the one-line standup summary on progress/blocker logs —
     cheapest, fully enforced in the schema.
   - *Harden (strong):* at session-close, if hours were logged but "remaining" never moved,
     require an update before closing.
   - *Harden (partial):* at session-close, if there were long silent gaps, require a
     catch-up log before closing cleanly. Keeps the existing nudge too.
   - *Leave as prose:* "call orient on resume" — the server can't force the AI to call a
     tool first, so this stays a written instruction.

---

## Theme A — Safe wins (no big decision, low risk, do anytime)

These change little or nothing you can see, but they're cheap and clearly good.

- **Match the locks** (DECIDED, ready to build). Make the dashboard `✓ done` button capture
  real hours before closing — through the same path the AI uses — instead of a bare
  "mark done". And stop the web route from editing Original Estimate after a task exists.
  Closes the "two doors, different locks" gap.
- **Trim the tool descriptions.** Shorten each MCP tool's blurb to 1–2 lines. Pure benefit —
  less of the AI's attention spent reading the menu, no behaviour change.

## Theme B — Make it installable by other developers (the big goal)

Three distinct pieces of the same goal. The first two are mostly safe; the third has a hard
half blocked by Decision #1.

- **Config place** (DECIDED needed). One screen/file where personal values live — timezone,
  Sun–Thu workweek, 9h day, Azure org/project/team, calendar link, paths — read from there
  instead of baked into the code. So a new installer isn't stuck with Moran's values.
- **Lean README** (DECIDED; *ask before drafting*). What it is, the three parts (the MCP the
  AI talks to, the dashboard you look at, the local database), how data flows, the core
  principles, and setup steps. Short and true — only the parts that don't churn.
- **Installation path** (DECIDED needed). Today it's separate manual moves only you know.
  - *Easy half:* a setup script + a prerequisites list (Node, Azure CLI logged in), that
    installs dependencies, sets up the database, and registers the MCP. Doable once the
    config place exists.
  - *Hard half:* making the dashboard server run reliably on someone else's machine instead
    of in a shell you keep open. **Blocked by Decision #1.**

## Theme C — Make it safe to change (foundational, blocked by Decision #2)

- **Tests around the six invariants.** Only if you choose to invest. Targets, already ranked:
  close flow, blocked/unblocked flow, Remaining/Completed math, stale-session nudge, cache
  refresh, calendar capacity. Start where they overlap with the pure-math files — highest
  payoff, easiest. These are also what would let the Dashboard split (Theme D) be done
  without holding your breath.

## Theme D — Keep the code workable (slow, ongoing, never a big-bang)

- **Split the giant Dashboard file** — but only opportunistically. Next time we build
  something that touches a piece of it (the sprint picker, the drawer, the standup card,
  etc.), peel *that* piece into its own file as part of the work. **Never** a standalone
  "cleanup day", never a from-scratch rewrite.
- **Modularize the MCP instruction manual** (the careful half of "split the monster"). Break
  the ~1000-line rulebook into smaller named pieces (vocabulary / effort / logging / greeting)
  that are *still assembled and sent to the AI at runtime*. Reorganizing, not removing —
  moving guardrail rules into docs the AI never reads would switch off the enforcement.

---

## Standing rules (not tasks — guardrails every future change checks)

- **ADO owns planning/status; sprint-helper owns context, memory, and guardrails.** Before
  storing any new fact, ask "does ADO already know this?" If yes, reflect it — never keep a
  competing copy. The code obeys this today; the silent timers are the one spot to keep
  one-way (they're the source of the old hours-math drift).
- **Enforce important rules in code, not prose.** A rule the AI can ignore is a sign; a rule
  the schema/tool refuses is a speed bump. Prefer speed bumps where a rule actually matters.

---

## Suggested order

(All three decisions are now settled, so this is the real working order.)

1. **Theme A** safe wins — match the locks, trim tool blurbs. Cheap, immediate.
2. **Harden rules 3 → 2 → 1** (standup summary required, then the two session-close checks).
   Small, high-value, and they protect your hours/standup data.
3. **The two-doorway Azure refactor** (CLI + API behind one interface) — foundational for
   both installation and config.
4. **Config place**, then the **easy half of installation**, then the **README**
   (README last so it describes the real, finished setup).
5. **Tests** — set up Vitest, cover the pure-math files first, then the six invariants.
   Do this before/alongside any Dashboard splitting so changes are safe.
6. **Theme D** ongoing — code-splitting only as you touch things; never a big-bang.
7. **Hard half of installation** — the server running reliably on someone else's machine,
   now unblocked by the two-doorway refactor.

*Full detail for each item lives in Claude's memory notes (the feedback/project files written
during the 2026-06-04 review discussion). A detailed, step-by-step build plan gets written
per item when you pick it up.*
