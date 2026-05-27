/* global React */
const { useState, useRef, useEffect } = React;

// ---------- sample data (from brief) ----------
const story = {
  id: "426267",
  title: "CODEOWNERS model — automate routing",
  state: "In progress",
  area: "Platform · Repo ops",
  description:
    "Replace the hand-edited CODEOWNERS file with a generated one based on team-membership data. Routing rules should accept the existing wildcard syntax and resolve to the on-call rotation when no team owner is set.",
  childCounts: { tasks: 3, going: 1, waiting: 2, done: 0 },
  logged: "2h 15m",
  estimate: 6,
  remaining: 3.75,
};

const initialTasks = [
  {
    id: "426268",
    title: "Wire ADO PATCH effort",
    elapsed: "1h 23m",
    estimate: 4,
    remaining: 2.5,
    state: "going",
    description:
      "Send PATCH /workitems/{id} on blur of Estimate or Remaining steppers. Throttle to one in-flight request per task; reconcile against the response payload so the displayed value matches what ADO accepted (it rounds to the nearest 0.25h).",
    parent: { type: "User Story", id: "426267", title: "CODEOWNERS model — automate routing" },
  },
  {
    id: "426269",
    title: "Test against staging org",
    elapsed: "0h",
    estimate: 2,
    remaining: 2,
    state: "waiting",
    description:
      "Point a copy of the helper at the staging AzDO org and run through the four edit paths: state change, estimate edit, remaining edit, focus switch. Confirm PATCH bodies match the schema in the staging account.",
    parent: { type: "User Story", id: "426267", title: "CODEOWNERS model — automate routing" },
  },
  {
    id: "426270",
    title: "Update CODEOWNERS docs",
    elapsed: "0h 52m",
    estimate: 1.5,
    remaining: 0.75,
    state: "waiting",
    description:
      "Document the new wildcard precedence rules and the on-call fallback. Add a short \"how to debug a missed routing\" section with the three most common config mistakes.",
    parent: { type: "User Story", id: "426267", title: "CODEOWNERS model — automate routing" },
  },
];

const initialChips = [
  {
    id: "426267",
    kind: "User Story",
    title: "CODEOWNERS model",
    going: 1, waiting: 2, done: 0,
    leftLabel: "3h 45m left",
    state: "going",
    estimate: 6,
    remaining: 3.75,
    area: "Platform · Repo ops",
    description:
      "Replace the hand-edited CODEOWNERS file with a generated one based on team-membership data.",
  },
  {
    id: "426280",
    kind: "User Story",
    title: "Outlook integration",
    going: 0, waiting: 4, done: 0,
    leftLabel: "12h left",
    state: "waiting",
    estimate: 12,
    remaining: 12,
    area: "Integrations · Calendar",
    description:
      "Surface a sync status indicator in the Outlook side-bar add-in when calendar events have been mirrored into the daybook.",
  },
  {
    id: "426301",
    kind: "Bug",
    title: "Sprint picker flicker",
    going: 0, waiting: 1, done: 0,
    leftLabel: "1h left",
    state: "waiting",
    estimate: 1,
    remaining: 1,
    area: "Sprint Helper · UI",
    description:
      "On sprint switch, the picker briefly renders the previous sprint's label before the live data resolves. Likely a stale-state read; fix by gating render on the resolved promise.",
  },
];

// ---------- atoms ----------

const Mono = ({ children, className = "", style }) => (
  <span className={`mono ${className}`} style={style}>{children}</span>
);

function fmtHours(n) {
  // 0.5 → "0.5h", 4 → "4h", 2.5 → "2.5h"
  if (Number.isInteger(n)) return `${n}h`;
  return `${n.toString()}h`;
}

// State pill picker — 3 segments
function StatePicker({ value, onChange }) {
  const [target, setTarget] = useState(null);
  const pills = ["waiting", "going", "done"];
  const handle = (next) => {
    if (next === value) return;
    setTarget(next);
    // simulate inflight then commit (mock — real impl: PATCH)
    setTimeout(() => {
      onChange?.(next);
      setTarget(null);
    }, 280);
  };
  return (
    <div className="statepick" role="radiogroup" aria-label="state">
      {pills.map((p) => (
        <button
          key={p}
          role="radio"
          aria-checked={value === p}
          className={`statepick-seg ${value === p ? "is-active" : ""} ${target === p ? "is-target" : ""}`}
          onClick={() => handle(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// Stepper — − value +, value is click-to-type, commits on blur/Enter
function Stepper({ value, onChange, step = 0.5, min = 0, max = 999, suffix = "h" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef(null);

  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    if (Number.isFinite(n) && n >= min && n <= max) {
      // snap to step
      const snapped = Math.round(n / step) * step;
      onChange?.(Math.round(snapped * 100) / 100);
    } else {
      setDraft(String(value));
    }
  };

  const bump = (dir) => {
    const next = Math.round((value + dir * step) * 100) / 100;
    if (next < min || next > max) return;
    onChange?.(next);
  };

  const display = `${value}${suffix}`;

  return (
    <div className="stepper">
      <button className="stepper-btn" onClick={() => bump(-1)} disabled={value <= min} aria-label="decrease">−</button>
      {editing ? (
        <input
          ref={inputRef}
          className="stepper-val"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setEditing(false); setDraft(String(value)); }
          }}
          inputMode="decimal"
          autoFocus
        />
      ) : (
        <button
          className="stepper-val"
          onClick={() => setEditing(true)}
          title="click to edit"
        >
          {display}
        </button>
      )}
      <button className="stepper-btn" onClick={() => bump(+1)} aria-label="increase">+</button>
    </div>
  );
}

// Chevron caret (rotates 90deg open)
const Caret = () => <span aria-hidden="true">›</span>;

// ---------- Task row (shared shell, variation-specific inner) ----------

function TaskRow({ task, open, onToggle, onChange, variation }) {
  return (
    <>
      <div className={`task-row state-${task.state} ${open ? "is-open" : ""}`}>
        <Mono className="task-id">#{task.id}</Mono>
        <div className="task-title">{task.title}</div>
        <Mono className="task-effort">
          {task.elapsed} <span className="of">/ {fmtHours(task.estimate)}</span>
        </Mono>
        <div className="task-state">{task.state === "going" ? "GOING" : task.state === "waiting" ? "WAITING" : "DONE"}</div>
        <div className="task-quickacts">
          {task.state !== "going" && (
            <button className="task-quick" title="start"><span className="task-quick-glyph">▶</span></button>
          )}
          {task.state === "going" && (
            <button className="task-quick" title="pause"><span className="task-quick-glyph">⏸</span></button>
          )}
          <button className="task-quick" title="mark done"><span className="task-quick-glyph">✓</span></button>
        </div>
        <button
          className={`chev ${open ? "is-open" : ""}`}
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? "collapse" : "expand"}
        >
          <Caret />
        </button>
      </div>
      <div className={`task-expand-wrap ${open ? "is-open" : ""}`}>
        <div className="task-expand">
          <div className="task-expand-inner">
            {variation === "a" ? (
              <TaskExpandA task={task} onChange={onChange} />
            ) : (
              <TaskExpandB task={task} onChange={onChange} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- Variation A — Field strip ----------

function TaskExpandA({ task, onChange }) {
  return (
    <>
      <div className="task-expand-context">
        <span>{task.parent.type}</span>
        <span className="dot">·</span>
        <span className="tag-id">#{task.parent.id}</span>
        <span className="dot">·</span>
        <span className="tag-title">{task.parent.title}</span>
      </div>
      <p className="task-expand-desc">{task.description}</p>
      <div className="task-expand-strip">
        <div className="group">
          <span className="label">STATE</span>
          <StatePicker value={task.state} onChange={(v) => onChange({ state: v })} />
        </div>
        <div className="group">
          <span className="label">ESTIMATE</span>
          <Stepper value={task.estimate} onChange={(v) => onChange({ estimate: v })} />
        </div>
        <div className="group">
          <span className="label">REMAINING</span>
          <Stepper value={task.remaining} onChange={(v) => onChange({ remaining: v })} />
        </div>
      </div>
      <div className="task-expand-foot">
        <span className="pushnote">edits push to Azure DevOps when you click away</span>
        <button className="ghost">see full description and comments →</button>
      </div>
    </>
  );
}

// ---------- Variation B — Two-column ----------

function TaskExpandB({ task, onChange }) {
  return (
    <>
      <div className="task-expand-left">
        <div className="task-expand-context">
          <span>{task.parent.type}</span>
          <span className="dot">·</span>
          <span className="tag-id">#{task.parent.id}</span>
          <span className="dot">·</span>
          <span className="tag-title">{task.parent.title}</span>
        </div>
        <div className="task-expand-desc-label">DESCRIPTION PREVIEW</div>
        <p className="task-expand-desc">{task.description}</p>
      </div>
      <div className="task-expand-divider" aria-hidden="true" />
      <div className="task-expand-right">
        <div className="editor-row">
          <span className="label">STATE</span>
          <StatePicker value={task.state} onChange={(v) => onChange({ state: v })} />
        </div>
        <div className="editor-row">
          <span className="label">ESTIMATE</span>
          <Stepper value={task.estimate} onChange={(v) => onChange({ estimate: v })} />
        </div>
        <div className="editor-row">
          <span className="label">REMAINING</span>
          <Stepper value={task.remaining} onChange={(v) => onChange({ remaining: v })} />
        </div>
      </div>
      <div className="task-expand-foot">
        <span>edits push to Azure DevOps when you click away</span>
        <button className="ghost">see full description and comments →</button>
      </div>
    </>
  );
}

// ---------- Chip row + chip expansion ----------

function Chip({ chip, open, onToggle }) {
  return (
    <div className={`chip ${chip.kind === "Bug" ? "bug" : ""} ${open ? "is-open" : ""}`} onClick={(e) => {
      // clicking the chip body (not the chev) opens the side drawer in real impl;
      // here it also toggles expand for demo. Don't toggle if you clicked the chev.
      if (e.target.closest(".chip-chev")) return;
    }}>
      <div className="chip-head">
        <span className="chip-kind">{chip.kind.toUpperCase()}</span>
        <Mono className="chip-id">#{chip.id}</Mono>
        <button
          className={`chip-chev ${open ? "is-open" : ""}`}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-expanded={open}
          aria-label={open ? "collapse" : "expand"}
        >
          <Caret />
        </button>
      </div>
      <h4 className="chip-title">{chip.title}</h4>
      <div className="chip-counts">
        <span className="c-going">{chip.going} going</span>
        <span className="sep">·</span>
        <span className="c-wait">{chip.waiting} waiting</span>
        <span className="sep">·</span>
        <span className="c-done">{chip.done} done</span>
      </div>
      <div className="chip-left">{chip.leftLabel}</div>
    </div>
  );
}

function ChipExpandA({ chip, onChange }) {
  return (
    <>
      <div className="chip-expand-meta">
        <span>{chip.kind}</span>
        <span className="sep">·</span>
        <Mono className="v">#{chip.id}</Mono>
        <span className="sep">·</span>
        <span className="v">{chip.state === "going" ? "going" : "waiting"}</span>
        <span className="sep">·</span>
        <span>{chip.area}</span>
        <span className="sep">·</span>
        <span>{chip.going + chip.waiting + chip.done} child task{chip.going + chip.waiting + chip.done === 1 ? "" : "s"}</span>
      </div>
      <p className="chip-expand-desc">{chip.description}</p>
      <div className="chip-expand-strip">
        <div className="group">
          <span className="label">STATE</span>
          <StatePicker value={chip.state} onChange={(v) => onChange({ state: v })} />
        </div>
        <div className="group">
          <span className="label">ESTIMATE</span>
          <Stepper value={chip.estimate} onChange={(v) => onChange({ estimate: v })} />
        </div>
        <div className="group">
          <span className="label">REMAINING</span>
          <Stepper value={chip.remaining} onChange={(v) => onChange({ remaining: v })} />
        </div>
      </div>
      <div className="chip-expand-foot">
        <span>edits push to Azure DevOps when you click away</span>
        <button className="ghost">open story details →</button>
      </div>
    </>
  );
}

function ChipExpandB({ chip, onChange }) {
  return (
    <>
      <div className="chip-expand-left">
        <div className="chip-expand-meta">
          <span>{chip.kind}</span>
          <span className="sep">·</span>
          <Mono className="v">#{chip.id}</Mono>
          <span className="sep">·</span>
          <span className="v">{chip.state}</span>
          <span className="sep">·</span>
          <span>{chip.area}</span>
        </div>
        <div className="chip-expand-desc-label">DESCRIPTION PREVIEW</div>
        <p className="chip-expand-desc">{chip.description}</p>
        <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.04em" }}>
          <Mono style={{ color: "var(--ink-1)" }}>{chip.going + chip.waiting + chip.done}</Mono> child tasks ·{" "}
          <Mono style={{ color: "var(--accent)" }}>{chip.going}</Mono> going ·{" "}
          <Mono style={{ color: "var(--ink-2)" }}>{chip.waiting}</Mono> waiting ·{" "}
          <Mono style={{ color: "var(--ink-2)" }}>{chip.done}</Mono> done
        </div>
      </div>
      <div className="chip-expand-divider" aria-hidden="true" />
      <div className="chip-expand-right">
        <div className="editor-row">
          <span className="label">STATE</span>
          <StatePicker value={chip.state} onChange={(v) => onChange({ state: v })} />
        </div>
        <div className="editor-row">
          <span className="label">ESTIMATE</span>
          <Stepper value={chip.estimate} onChange={(v) => onChange({ estimate: v })} />
        </div>
        <div className="editor-row">
          <span className="label">REMAINING</span>
          <Stepper value={chip.remaining} onChange={(v) => onChange({ remaining: v })} />
        </div>
      </div>
      <div className="chip-expand-foot">
        <span>edits push to Azure DevOps when you click away</span>
        <button className="ghost">open story details →</button>
      </div>
    </>
  );
}

// ---------- Variation container ----------

function Variation({ id, label, description, variation, initialOpenTasks, initialOpenChip = "426267", showNotes = true }) {
  // Default expanded states per the brief — one task collapsed, one expanded; one chip expanded.
  const [tasks, setTasks] = useState(initialTasks);
  const [openTasks, setOpenTasks] = useState(initialOpenTasks || { "426268": true });

  const [chips, setChips] = useState(initialChips);
  const [openChip, setOpenChip] = useState(initialOpenChip); // only one at a time

  const toggleTask = (id) => setOpenTasks((s) => ({ ...s, [id]: !s[id] }));
  const updateTask = (id, patch) =>
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const toggleChip = (id) => setOpenChip((c) => (c === id ? null : id));
  const updateChip = (id, patch) =>
    setChips((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const openChipObj = chips.find((c) => c.id === openChip);

  return (
    <div className={`s17 ${variation === "a" ? "va" : "vb"}`} data-screen-label={`${id} ${label}`}>
      <div className="s17-var-cap">
        <span className="label">{label}</span>
        <span className="desc">{description}</span>
      </div>

      {/* Active Story card */}
      <article className="story-card">
        <div className="story-card-head">
          <span className="story-card-flag">
            <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
            <span className="dim-cap">ACTIVE STORY</span>
          </span>
          <Mono className="story-card-id">#{story.id}</Mono>
          <span className="story-card-meta dim-cap">In progress · 3 tasks assigned to you</span>
        </div>
        <h2 className="story-card-title">{story.title}</h2>

        <div className="story-card-summary">
          <div>
            <span className="dim-cap">LOGGED</span>
            <span className="v">2h 15m</span>
          </div>
          <div>
            <span className="dim-cap">ESTIMATE</span>
            <span className="v">6h</span>
          </div>
          <div>
            <span className="dim-cap">REMAINING</span>
            <span className="v">3h 45m</span>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <span className="dim-cap">CHILDREN</span>
            <span className="v dim">3 tasks</span>
          </div>
        </div>

        <div className="tasks-label">
          <span className="dim-cap">TASKS</span>
          <span style={{ fontSize: 11, color: "var(--ink-4)", letterSpacing: "0.04em" }}>
            tap <span style={{ color: "var(--ink-2)", fontFamily: "var(--font-mono)" }}>›</span> on a row for quick edits · multiple may be open
          </span>
        </div>
        <div>
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              open={!!openTasks[t.id]}
              onToggle={() => toggleTask(t.id)}
              onChange={(patch) => updateTask(t.id, patch)}
              variation={variation}
            />
          ))}
        </div>
      </article>

      {/* My user stories */}
      <section className="chips-section">
        <div className="chips-head">
          <h3 className="chips-title">My user stories</h3>
          <span className="chips-meta">3 parents · only one can be expanded at a time</span>
        </div>
        <div className="chips-grid">
          {chips.map((c) => (
            <Chip
              key={c.id}
              chip={c}
              open={openChip === c.id}
              onToggle={() => toggleChip(c.id)}
            />
          ))}
          <div className={`chip-expand-wrap ${openChipObj ? "is-open" : ""}`}>
            <div className="chip-expand">
              {openChipObj && (
                <div className="chip-expand-inner">
                  {variation === "a" ? (
                    <ChipExpandA chip={openChipObj} onChange={(p) => updateChip(openChipObj.id, p)} />
                  ) : (
                    <ChipExpandB chip={openChipObj} onChange={(p) => updateChip(openChipObj.id, p)} />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {showNotes && <div className="s17-notes">
        <b>Slice 1.7 — what's new</b>
        <ul>
          <li>Chevron <code>›</code> on every task row and every story chip — click to expand a soft strip in place. Multiple tasks can stay open; only one chip can.</li>
          <li>Inline editors: <code>state</code> as a 3-segment pill (waiting · going · done), <code>estimate</code> and <code>remaining</code> as <code>−</code><code>value</code><code>+</code> steppers. Click the value to type. Commits on blur or Enter — no Save button.</li>
          <li>Side drawer behavior is unchanged. The ghost <i>"see full description and comments →"</i> link still opens it.</li>
        </ul>
      </div>}
    </div>
  );
}

window.VariationA = () => (
  <Variation
    id="01"
    label="Variation A — Field strip"
    description="Expand panel is one calm horizontal strip · description above · STATE / ESTIMATE / REMAINING flow left-to-right"
    variation="a"
  />
);
window.VariationAExpanded = () => (
  <Variation
    id="01b"
    label="Variation A — all expanded"
    description="Max-footprint state · every task and the focused chip open at once · so the engineer can see cumulative height"
    variation="a"
    initialOpenTasks={{ "426268": true, "426269": true, "426270": true }}
    initialOpenChip="426267"
    showNotes={false}
  />
);
window.VariationB = () => (
  <Variation
    id="02"
    label="Variation B — Two-column"
    description="Expand panel splits · parent context + description on the left · labeled editor stack on the right"
    variation="b"
  />
);
