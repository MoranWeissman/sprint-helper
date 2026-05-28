# sprint-helper — the complete design

_Written 2026-05-28. This is the whole-solution vision — the picture that ties every
piece together, so we stop discovering missing functionality one slice at a time._

> Read this top to bottom. It's written in plain English on purpose — it's for Moran,
> not for engineers. The "how we build it" details live in the per-slice plans, not here.

---

## The one idea

sprint-helper is an **AI-run organizer for your sprint**.

Claude Code works *alongside* you and keeps your sprint honest and up to date. The UI is
the calm picture of all of it — built so an ADHD brain always knows the one thing that
matters right now, and never has to hold the whole sprint in its head.

You are not the one keeping the board tidy. The assistant is. Your job is to do the work
and answer the occasional plain-English question; everything else (logging, time, status,
nudges) happens around you.

---

## How the screen behaves

The home screen has **two states**, and it switches itself based on whether you're
actively working:

- **Overview** — no work session is running. The calm board: where you are in the sprint,
  what's next, the helper's notes, your real capacity. This answers _"where am I in the
  sprint?"_
- **Focus** — a work session is live. The screen narrows to the **one task** you're on.
  Everything else recedes. This answers _"what am I doing right now?"_

**It morphs automatically** — you never push a button to switch. When a session starts,
the board quiets and the current task takes over; when it ends, the board comes back.

> Decision on record: morph automatically (not a separate place you step into). One focal
> point at a time is the whole ADHD point.

---

## The session loop — the engine

This is the heartbeat. It happens every time you work in Claude Code:

1. **Start → orient.** The session opens and sprint-helper greets you first: here's where
   you left off, here's what's planned — what are you picking up today?
2. **Match.** You answer in plain words. It finds the matching story + task.
   - If what you're doing **isn't in the sprint**, it catches you:
     _"This isn't in your sprint — is it a quick 1–2h thing, or should we make a story for
     it?"_ You decide; it acts only after you confirm.
3. **Work → quiet log.** As you work, it logs progress, blockers, and decisions onto the
   task's activity, and quietly tracks how long the session's been open. No ticking
   counter anywhere.
4. **End → close the loop.** When you wrap up, it offers a one-line summary and asks
   _"is this done?"_
   - **Yes** → it proposes closing the task; you confirm, then it closes it in Azure DevOps.
   - **No** → it leaves the task open and remembers exactly where you stopped, so next time
     the orientation step can pick the thread back up.

> Decision on record: **nothing is written to Azure DevOps without your confirmation.**
> The assistant always proposes; you always nod. Safest, least surprising.

The orientation step (1) is a **designed ritual**, not just a tool sitting there waiting to
be called. The whole reason sprint-helper exists is that it greets you and checks your work
against the sprint *every* time you sit down — that's what keeps you from drifting.

---

## Time, tracked silently

No stopwatches. Nothing ticking.

sprint-helper simply knows how long each task's sessions were open, and adds it up quietly
in the background until the task is done. You only ever see a **calm total**, and only
where it actually helps you — for example _"about 3h across 2 sittings"_ on a task you're
reviewing. Never a live number counting up at you.

> Decision on record: this **replaces** the visible start/pause timers that exist today.

---

## Capacity from your calendar (Outlook)

sprint-helper reads your Outlook calendar to understand your **real** desk time — because
meetings eat your sprint, and a plan that ignores them is a lie.

It does the simple math for you:

> _"This sprint you've got about 18h of real work time after meetings — but you've planned
> 25h. That's more than fits."_

- It lives in the **Overview** so you always see plan-vs-reality.
- You can also ask Claude Code for it on demand (_"what's my real capacity this week?"_),
  and it can nudge your effort expectations based on the answer.

> This moves Outlook from "nice to have later" to a **central** part of keeping you honest.

---

## The helper's notes

A **free space in the Overview** where the assistant writes its honest read on your sprint,
in plain, casual, human English — not a robot, not academic.

Examples of what shows up there:

- _"You've been heads-down on the ArgoCD task for two days — it's bigger than the 2h guess.
  Want to bump the estimate?"_
- _"You've got 3 meetings tomorrow, so today's your clear runway — good day for the
  migration."_
- _"Two tasks have had no movement since Monday. Still on your radar, or drop them?"_

It's the assistant talking *to you* about your sprint, right inside your dashboard. This is
where the "organizer in your corner" feeling lives.

---

## How the existing modes fit

Each mode now clearly serves the operating model above:

| Mode | What it's for |
|------|----------------|
| **Day** | Home. Overview ↔ Focus. Helper's notes, capacity, what's next, live activity. |
| **Pre-plan** | What's carrying over, your real capacity, what the helper suggests taking on. |
| **Plan** | Set up stories + tasks with efforts, checked against real capacity. |
| **Demo** | Prep *for you*: what you actually did, pulled from closed tasks + the activity the AI logged all sprint. |
| **Retro** | The helper's notes across the sprint become honest looking-back material. |
| **Inbox** | Stray "quick things" the guardrail captured, ready to promote into real stories later. |

The structure of planned work stays the same as Azure DevOps: **stories hold tasks, and
tasks carry the effort**. Your work sessions attach to tasks.

---

## What this changes from what we've already built

- Visible start/pause timers **→ silent tracking** (simplifies the current timer feature).
- The board is no longer the only view — the **Focus** state is new.
- The **helper's notes** panel is new.
- **Outlook capacity** moves from "later, optional" to **central**.
- The session-start orientation becomes a **designed ritual** that fires every session,
  not just a passive tool waiting to be asked.

---

## What we're deliberately NOT doing (so it stays calm)

- No live ticking timers, no productivity scores, no streaks, no gamification.
- No multi-user / team features — this is a solo tool, forever.
- No automatic writes to Azure DevOps without a confirm.
- No second dashboard — activity and focus live inside the Day screen, not a separate page.

---

## How we'll build it (in slices, as usual)

This is the order that turns the vision real without a big-bang rewrite. Each is its own
plan + Claude Design pass + implementation, the way we've worked all along.

1. **Silent time + close-the-loop.** Replace visible timers with silent session time, and
   add the "is this done? → close it (you confirm)" end-of-session step.
2. **Focus state.** Make the Day screen morph to the single current task when a session is
   live, and back to the board when it ends.
3. **Helper's notes.** The free plain-English space in the Overview where the assistant
   writes its read on the sprint.
4. **Orientation ritual.** Make the session-start greeting + sprint check fire reliably
   every session (the proactive "where did we leave off / what are you picking up" moment).
5. **Outlook capacity.** Read the calendar, compute real desk time, show plan-vs-reality,
   make it askable via Claude Code.
6. **The modes catch up.** Re-ground Demo, Retro, Pre-plan/Plan, and Inbox on top of the
   above (these are the existing slice-4/5 items, now with richer material to work from).

Exact ordering is flexible — this is the suggested path, not a contract.

---

## Things to settle when we get there (not blocking)

- **Helper's notes shape:** one running stream of notes over time, or a single living
  summary the assistant rewrites? (Lean: a short living summary + a few recent notes.)
- **What counts as "where you left off":** the last open task with activity, or something
  you explicitly pin? (Lean: last task with an open/unfinished session.)
- **Off-screen work:** capacity comes from Outlook, but do you also want to tell the helper
  "I'm in a meeting now" out loud, or is the calendar enough? (Lean: calendar is enough for
  v1; revisit if it feels thin.)
