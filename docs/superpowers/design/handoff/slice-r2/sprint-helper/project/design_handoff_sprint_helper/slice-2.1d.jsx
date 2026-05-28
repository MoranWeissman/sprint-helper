/* global React */
const { useState } = React;

// ---------- data ----------

const story = {
  id: "426260",
  kind: "User Story",
  title: "Discovery: Access & Guardrails",
  going: 1, waiting: 2, done: 0,
  description:
    "Map the access surface we'll need before opening branch protection to product. Two artifacts come out of this: a generated CODEOWNERS file, and a documented set of branch-protection rules per repo class.",
  state: "going",
  area: "Platform · Repo ops",
};

const tasksUnderStory = [
  { id: "426267", title: "CODEOWNERS model", state: "waiting", elapsed: "0h", estimate: "4h", live: false, events: [] },
  { id: "426268", title: "Branch protection rules", state: "going", elapsed: "1h 23m", estimate: "4h", live: true, liveSince: "14:18" },
];

// Activity events for #426268 — newest LAST in real time, but we display newest FIRST
const eventsForTask = [
  { time: "14:32", type: "focus",    body: "Started on auth refactor" },
  { time: "14:45", type: "blocker",  body: "Token expiry edge case" },
  { time: "15:12", type: "decision", body: "Use refresh tokens, not session cookies" },
  { time: "15:30", type: "progress", body: "Refactored middleware, opened PR #42" },
  { time: "15:48", type: "note",     body: "Circle back to error messages" },
];
const reversedEvents = [...eventsForTask].reverse(); // newest first

// "Live now" sidebar sessions
const liveSessions = [
  { id: "426268", title: "Branch protection rules", elapsed: "14 min", parent: "Discovery: Access & Guardrails" },
  { id: "426301", title: "Sprint picker flicker",    elapsed: "4 min",  parent: "Sprint Helper · UI" },
];

// Second story chip — no live child, to show layout unchanged
const otherStory = {
  id: "426280",
  kind: "User Story",
  title: "Outlook integration · sync status",
  going: 0, waiting: 4, done: 0,
};

// ---------- atoms ----------

const Mono = ({ children, style }) => <span className="mono" style={style}>{children}</span>;

// Two variants of the live marker
function LiveMarker({ variant, rollup }) {
  if (variant === "a") {
    return (
      <span className={`live-pill ${rollup ? "is-rollup" : ""}`} title={rollup ? "1 task has Claude Code working on it" : "Claude Code is working on this"}>
        {rollup ? "live · 1 task" : "live"}
      </span>
    );
  }
  // variant b — static dot with tooltip
  return (
    <span
      className={`live-dot ${rollup ? "is-rollup" : ""}`}
      data-tip={rollup ? "1 child task has Claude Code working on it" : "Claude Code is working on this"}
      tabIndex={0}
      aria-label={rollup ? "1 child task is live" : "live — Claude Code is working on this"}
    />
  );
}

// Event row
function EventRow({ event }) {
  const labelByType = {
    focus: "Focus",
    progress: "Progress",
    blocker: "Blocker",
    decision: "Decision",
    note: "Note",
  };
  return (
    <div className="s21-ev">
      <span className="s21-ev-time">{event.time}</span>
      <span className={`s21-ev-type t-${event.type}`}>{labelByType[event.type]}</span>
      <span className="s21-ev-body truncate" title={event.body}>{event.body}</span>
    </div>
  );
}

function ActivityFeed({ events, max = 5, scope = "task" }) {
  const [expanded, setExpanded] = useState(false);
  const total = events.length;
  const visible = expanded ? events.slice(0, 20) : events.slice(0, max);
  return (
    <div className="s21-activity">
      <div className="s21-activity-head">
        <span className="s21-activity-title">Recent activity</span>
        {scope === "chip" && (
          <span className="s21-activity-meta">rolled up across 2 tasks</span>
        )}
      </div>
      {total === 0 ? (
        <p className="s21-empty">Nothing yet. Claude Code will log things here as you work.</p>
      ) : (
        <>
          <div className="s21-activity-list">
            {visible.map((e, i) => <EventRow key={i} event={e} />)}
          </div>
          {total > max && (
            <button
              className="s21-activity-more"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? `Show recent only` : `${max} of ${total} · show all`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Mini state pill (read-only display)
function StatePill({ value }) {
  const pills = ["waiting", "going", "done"];
  return (
    <div className="s21-statepick">
      {pills.map((p) => (
        <span key={p} className={`s21-statepick-seg ${value === p ? "is-active" : ""}`}>{p}</span>
      ))}
    </div>
  );
}
function Stepper({ value }) {
  return (
    <div className="s21-stepper">
      <span className="s21-stepper-btn">−</span>
      <span className="s21-stepper-val">{value}</span>
      <span className="s21-stepper-btn">+</span>
    </div>
  );
}

// ---------- the variation container ----------

function Variation({ id, label, description, variant }) {
  const [storyOpen, setStoryOpen] = useState(true);
  const [openTask, setOpenTask] = useState("426268"); // only one expanded for clarity
  const [emptyOpen, setEmptyOpen] = useState(true);   // open #426267 to show empty state

  const Chev = ({ open }) => <span aria-hidden="true">›</span>;

  return (
    <div className={`s21 ${variant === "a" ? "va" : "vb"}`} data-screen-label={`${id} ${label}`}>
      <div className="s21-var-cap">
        <span className="label">{label}</span>
        <span className="desc">{description}</span>
      </div>

      {/* sidebar */}
      <aside className="s21-side">
        <div className="s21-side-greeting">
          Day · <span className="name">Moran</span>
        </div>

        {/* LIVE NOW tile — only when at least one session is open */}
        <div className="livenow">
          <div className="livenow-head">
            <span className="livenow-dot" aria-hidden="true" />
            <span className="livenow-title">LIVE NOW · 2 SESSIONS</span>
          </div>
          <div className="livenow-list">
            {liveSessions.map((s) => (
              <button key={s.id} className="livenow-item" title={`Jump to ${s.title}`}>
                <span className="livenow-item-title">{s.title}</span>
                <span className="livenow-item-elapsed">{s.elapsed}</span>
                <span className="livenow-item-sub">{s.parent}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="upnext">
          <div className="upnext-title">UP NEXT</div>
          <div className="upnext-item">Sprint review prep <Mono>· 1h</Mono></div>
          <div className="upnext-item">2FA settings page <Mono>· 3h</Mono></div>
        </div>

        <div className="rail">
          <div className="rail-cap">REMAINING THIS SPRINT</div>
          <div className="rail-big">17h</div>
          <div className="rail-sub">across 6 tasks</div>
        </div>
      </aside>

      {/* main */}
      <div className="s21-main">
        <div className="s21-section-head">
          <h3 className="s21-section-title">My user stories</h3>
          <span className="s21-section-meta">2 parents · 1 live</span>
        </div>

        {/* STORY CHIP — open, with rolled-up activity */}
        <article className={`s21-chip is-live is-open`}>
          <div className="s21-chip-head">
            <span className="s21-chip-kind">{story.kind.toUpperCase()}</span>
            <Mono><span className="s21-chip-id">#{story.id}</span></Mono>
            <span className="s21-chip-live">
              <LiveMarker variant={variant} rollup />
            </span>
            <button
              className={`s21-chip-chev ${storyOpen ? "is-open" : ""}`}
              onClick={() => setStoryOpen((v) => !v)}
              aria-expanded={storyOpen}
              aria-label="collapse"
            >
              <Chev open={storyOpen} />
            </button>
          </div>
          <div className="s21-chip-title-row">
            <h4 className="s21-chip-title">{story.title}</h4>
          </div>
          <div className="s21-chip-counts">
            <span className="c-going">{story.going} going</span>
            <span className="sep">·</span>
            <span>{story.waiting} waiting</span>
            <span className="sep">·</span>
            <span className="c-done">{story.done} done</span>
          </div>

          <div className={`s21-expand-wrap ${storyOpen ? "is-open" : ""}`}>
            <div className="s21-expand">
              <div className="s21-expand-inner">
                <div className="s21-meta-line">
                  <span>{story.kind}</span>
                  <span className="sep">·</span>
                  <span className="v">going</span>
                  <span className="sep">·</span>
                  <span>{story.area}</span>
                  <span className="sep">·</span>
                  <span>2 child tasks</span>
                </div>
                <p className="s21-desc">{story.description}</p>
                <div className="s21-strip">
                  <div className="group">
                    <span className="label">STATE</span>
                    <StatePill value={story.state} />
                  </div>
                  <div className="group">
                    <span className="label">ESTIMATE</span>
                    <Stepper value="8h" />
                  </div>
                  <div className="group">
                    <span className="label">REMAINING</span>
                    <Stepper value="6.5h" />
                  </div>
                </div>

                <div className="s21-divider" />

                {/* rolled-up activity */}
                <ActivityFeed events={reversedEvents} scope="chip" max={5} />

                <div className="s21-divider" />

                {/* child tasks inline */}
                <div className="s21-tasks-cap">
                  <span className="label">TASKS</span>
                  <span className="s21-activity-meta">expand a task for its own activity feed</span>
                </div>
                <div className="s21-tasks-list">
                  {tasksUnderStory.map((t) => {
                    const isOpen = openTask === t.id;
                    const isEmpty = t.id === "426267" && emptyOpen;
                    const showOpen = isOpen || isEmpty;
                    return (
                      <div key={t.id} className={`s21-task state-${t.state} ${showOpen ? "is-open" : ""}`}>
                        <div
                          className="s21-task-row"
                          onClick={() => {
                            if (t.id === "426268") setOpenTask((p) => (p === t.id ? null : t.id));
                            else setEmptyOpen((v) => !v);
                          }}
                        >
                          <Mono><span className="s21-task-id">#{t.id}</span></Mono>
                          <span className="s21-task-title">{t.title}</span>
                          <Mono><span className="s21-task-effort">{t.elapsed} / {t.estimate}</span></Mono>
                          <span className="s21-task-state">
                            {t.state === "going" ? "GOING" : "WAITING"}
                          </span>
                          <span className="s21-task-live">
                            {t.live ? <LiveMarker variant={variant} /> : null}
                          </span>
                          <span className={`s21-task-chev ${showOpen ? "is-open" : ""}`}>›</span>
                        </div>
                        <div className={`s21-task-expand-wrap ${showOpen ? "is-open" : ""}`}>
                          <div className="s21-task-expand">
                            <div className="s21-task-expand-inner">
                              <div className="s21-meta-line">
                                <span>Task</span>
                                <span className="sep">·</span>
                                <span className="v">{t.state}</span>
                                <span className="sep">·</span>
                                <span>parent: <Mono>#{story.id}</Mono></span>
                                {t.live && (
                                  <>
                                    <span className="sep">·</span>
                                    <span>live since <Mono style={{ color: "var(--ink-1)" }}>{t.liveSince}</Mono></span>
                                  </>
                                )}
                              </div>
                              <div className="s21-strip">
                                <div className="group">
                                  <span className="label">STATE</span>
                                  <StatePill value={t.state} />
                                </div>
                                <div className="group">
                                  <span className="label">ESTIMATE</span>
                                  <Stepper value={t.estimate} />
                                </div>
                                <div className="group">
                                  <span className="label">REMAINING</span>
                                  <Stepper value={t.id === "426268" ? "2.5h" : "4h"} />
                                </div>
                              </div>
                              <div className="s21-divider" />
                              {t.id === "426268" ? (
                                <ActivityFeed events={reversedEvents} scope="task" max={5} />
                              ) : (
                                <div className="s21-activity">
                                  <div className="s21-activity-head">
                                    <span className="s21-activity-title">Recent activity</span>
                                  </div>
                                  <p className="s21-empty">Nothing yet. Claude Code will log things here as you work.</p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </article>

        {/* Static reference frame — chip with no live child, to confirm layout unchanged */}
        <div className="s21-static-frame">
          <span className="cap">REFERENCE · CHIP WITH NO LIVE CHILD</span>
          <article className="s21-chip">
            <div className="s21-chip-head">
              <span className="s21-chip-kind">{otherStory.kind.toUpperCase()}</span>
              <Mono><span className="s21-chip-id">#{otherStory.id}</span></Mono>
              {/* no live marker — confirming absence */}
              <button className="s21-chip-chev" aria-label="expand">›</button>
            </div>
            <div className="s21-chip-title-row">
              <h4 className="s21-chip-title">{otherStory.title}</h4>
            </div>
            <div className="s21-chip-counts">
              <span>{otherStory.going} going</span>
              <span className="sep">·</span>
              <span>{otherStory.waiting} waiting</span>
              <span className="sep">·</span>
              <span className="c-done">{otherStory.done} done</span>
            </div>
          </article>
        </div>

        <div className="s21-notes">
          <b>Slice 2.1d — what to look for</b>
          <ul>
            <li><b>Live marker</b> ({variant === "a" ? "inline pill" : "static dot"}): on task <Mono>#426268</Mono> (full marker) and on the parent chip header (rolled-up marker — dimmer). The reference frame at the bottom has none.</li>
            <li><b>Recent activity</b> sits below the editor strip inside the existing expand panel. Same 5 events show in the chip's rolled-up feed and in the task's own feed (chip rolls up across both child tasks).</li>
            <li><b>Empty state</b>: task <Mono>#426267</Mono> is expanded showing the empty-state copy.</li>
            <li><b>Live now</b> sidebar tile: 2 sessions; tile hides entirely when none are open.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

window.VariationLivePill = () => (
  <Variation
    id="01"
    label="Variation A — Inline pill · ruled feed"
    description="Live marker is a lowercase mono 'live' pill · activity rows separated by hairline rules · feels like a tidy log"
    variant="a"
  />
);
window.VariationLiveDot = () => (
  <Variation
    id="02"
    label="Variation B — Static dot · journal feed"
    description="Live marker is a single static accent dot with tooltip · activity rows breathe, no rules · feels like a notes journal"
    variant="b"
  />
);
