# Sprint Helper — R2 design brief (Focus state + calmer Day)

Paste this into the **same Claude Design chat** where you did slices 1.7, 4a, and 2.1d — it already knows the palette, fonts, components, the chip grid, the active-story card, and the activity feed. End your message with **"give me 2 variations"**.

---

## Context — what's already built

The Day dashboard today (top to bottom):
- a slim metric bar across the top (LOGGED · REMAINING · ESTIMATE · DAYS · GOING · NEXT),
- a row of story chips ("MY USER STORIES", click to focus),
- one big **active-story card** (logged / estimate / remaining + the story's tasks),
- two list columns underneath (a daily draft + an "in this sprint" list).

Dark warm-dusk palette, single moonlit-blue accent, Geist + Geist Mono. There's already a "live" marker (a small pill) that appears when Claude Code has an open session on a task, and a "Recent activity" feed inside the expand panels.

**What just changed (R1):** time is now tracked silently — no start/stop buttons, no ticking. When I work in Claude Code, it opens a *session* against a task; each task shows a calm static total like **"3h · 2 sittings"** instead of a stopwatch.

## The problem I'm fixing

Two things, one root cause:

1. **The big focus card doesn't follow what I'm actually working on.** When Claude Code opens a session on a task, the dashboard still shows whatever story its old "most active" guess picked — not the task I'm live on. I want the screen to put *the thing I'm working on right now* front and centre.
2. **The Day view feels busy / messy.** Everything is on screen at once. I have ADHD — I need **one focal point**, not a wall.

## What I'm adding now — two states for the Day screen

The Day screen should have **two states, and switch between them on its own** depending on whether a session is live:

- **Overview** — *no* live session. The calm board: where I am in the sprint, my stories, what's next. This answers *"where am I?"* It should feel noticeably **calmer and less crowded than today**.
- **Focus** — a session *is* live. The screen narrows to the **one task I'm working on**; everything else recedes. This answers *"what am I doing right now?"*

It morphs **automatically** — I never click a toggle. (A small, quiet "show the whole board" escape from Focus is fine, but the default is automatic.)

## Vocabulary (use this exact wording)

- The two states, if ever labelled: **"Overview"** and **"Focus"** (but prefer no big labels — let the layout speak).
- Keep using **"live"** (lowercase mono) for an open session, and **"Recent activity"** for the feed.
- The calm time total reads like **"3h · 2 sittings"** (logged total · number of work sittings). Singular: **"1 sitting"**.
- **Never** say "session", "standup", "ceremony", or "sprint 26_11" in user-facing text. (If you redraw the lists area, the current "STANDUP DRAFT" label should become plain English like **"For your daily"** or **"Daily note"**.)

## Hard constraints (respect strictly)

- **Palette**: `oklch(0.135 0.028 260)` bg, `oklch(0.95 0.014 230)` text, single accent `oklch(0.78 0.075 245)`. No second accent.
- **ADHD-friendly**: one focal point at a time, **no pulsing**, no decorative motion. Subtle 180–220ms ease only, for the Overview↔Focus morph. The "live" dot/pill is static.
- **Typography**: Geist (UI), Geist Mono (numbers / ids / clock / time totals).
- **No emoji.** Sparing unicode only.
- **Calm density** — generous whitespace. When in doubt, remove, don't add.

## Bit 1 — Focus state (the main thing)

When a session is live, the screen centres on that **one task**. Design a focused view that shows, calmly:

- the **task title**, big, as the focal point;
- its **parent story** as quiet context above it (story title · #id);
- the **"live"** marker (static);
- the calm **time total** (e.g. "3h · 2 sittings") and **estimate / remaining**;
- the task's **Recent activity** feed (the focus, progress, blocker, decision, note entries Claude Code has logged) — this is the rich part, since it's *what I've been doing*.

Everything else (the other chips, the lists, the full metric bar) should **recede**. Two directions for *how* it recedes — that's the main thing I want to compare:

- **Variation A — Collapse:** the rest of the board collapses up into a thin, quiet strip at the top (sprint name · day · a tiny "N more in sprint" you can click to expand back to Overview). The focused task owns the rest of the screen.
- **Variation B — Recede behind:** the focused task sits on a calm centred panel; the board is still faintly present behind it (dimmed, not blurred to noise), so I keep a sense of place. A quiet "show the whole board" link returns to Overview.

For both: show how I get **back to Overview** without ending my work, and keep it one quiet affordance, not a row of buttons.

## Bit 2 — Calmer Overview

Redraw the no-session Day view to feel calmer than today. You have freedom here, but the goals:

- **Quiet the metric bar.** Six equal big numbers is a lot. Group or de-emphasise — maybe one or two headline numbers (e.g. remaining vs. estimate, day of sprint) and tuck the rest smaller.
- **The chips can stay**, but give them room to breathe; they're the board.
- **The lists** (daily draft + in-sprint) should feel like quiet reference, not a second focal point — smaller, lighter, lower.
- When nothing is live, there's **no big "active story" card** demanding attention. Instead, a calm, optional one-line prompt is fine (e.g. *"Last on: Design the ApplicationSets"* or *"Nothing live — pick something above"*). Keep it gentle.

## Bit 3 — When more than one session is live

I usually work on one thing, but sometimes two. Keep **one** task as the focal point (the **most recently started** session), and show the other live one as a small, quiet secondary marker (e.g. a slim "also live: Deploy ArgoCD" chip I can click to make it the focus). Do **not** split the screen 50/50 — that breaks the one-focal-point rule.

## Sample data to use in the mockup

```
User:    moran        Sprint day 4 of 12        Wednesday 14:32
Capacity: logged 37h · estimate 12h · remaining 12h · 4 going · 14 waiting

LIVE (Focus state should centre on this one):
  Parent story:  Deploy ArgoCD to prod cluster  ·  #434964
  Task:          #432010  "Flip deployArgoCD to true + add prod values"
                 live · started 14:18
                 logged 2h · 2 sittings   ·   estimate 4h · remaining 2h

  Recent activity (newest first):
    14:32  Focus     Picked up the prod ArgoCD install
    14:40  Decision  Merge of deploy branch IS the install mechanism
    14:52  Blocker   Prod uses scoped policies, not cluster-admin
    15:05  Progress  Confirmed EKS access entry + policies in place

Other stories (recede in Focus / are the board in Overview):
  #431995  Design: devex-infrastructure — Repo Structure, Schema, ApplicationSets   (2 going)
  #434963  [Cluster-Addons] Prod cluster onboarding   (feature · 1 task)
  #434966  Validate addon rollout from prod ArgoCD across clusters   (4 waiting)
  #434965  Create prod cluster-addons repo + bootstrap into prod ArgoCD   (4 waiting)
  #426271  Discovery: ArgoCD ApplicationSet Design   (1 waiting)
```

Use this exact data so I can compare the two states with real-feeling content.

## Anti-patterns to avoid

- **A manual mode toggle** for Overview vs Focus. It follows my work automatically.
- **Splitting the screen** between two live tasks. One focal point.
- **Keeping the busy metric bar + active card + lists all loud at once.** That's the thing I'm fixing.
- **A separate "Focus" page or tab.** It's the same Day screen, morphing.
- **Pulsing / animated live markers, toasts, notifications.** Calm and static.
- **Bright red blockers / bright green progress** in the activity feed. Stay muted.
- **The word "session" / "standup" / "ceremony"** anywhere user-facing.

## Deliverable

Two variations (A: collapse, B: recede-behind) of:
- The **Focus state** — the focused live task with parent context, time total, estimate/remaining, and its Recent activity feed, with the rest of the board receded.
- The **Overview state** (calmed) — no session live.
- A small frame showing **two sessions live** and how the secondary one is offered without splitting focus.

Standalone HTML, single file with shared CSS. Reuse the existing dashboard's OKLCH palette, Geist fonts, chip + activity-row styling. When you're happy, Export → Handoff to Claude Code.
