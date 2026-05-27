/* global React */
const { useState, useEffect } = React;

// ---------- mode glyphs — minimal SVG, single-stroke, 18px box ----------
const Glyph = {
  day: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="11" r="3.5" />
      <path d="M9 4.5 v1.6 M14.5 11 h-1.6 M5.1 11 h-1.6 M12.5 7.5 l1.1 -1.1 M5.5 7.5 l-1.1 -1.1" />
    </svg>
  ),
  preplan: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="9" r="5.4" strokeDasharray="2 2.2" />
      <path d="M9 6.3 v3 h2.6" />
    </svg>
  ),
  plan: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <rect x="3.4" y="3.4" width="11.2" height="11.2" rx="1.2" />
      <path d="M5.8 7.2 h6.4 M5.8 10 h6.4 M5.8 12.8 h3.8" />
    </svg>
  ),
  demo: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 5.8 v6.4 l5.4 -3.2 z" />
    </svg>
  ),
  retro: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.4 9 a5.4 5.4 0 1 1 -1.9 -4.1" />
      <path d="M14.5 3.8 v3 h-3" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="9" r="2.2" />
      <path d="M9 3.4 v1.6 M9 13 v1.6 M3.4 9 h1.6 M13 9 h1.6 M5.1 5.1 l1.1 1.1 M11.8 11.8 l1.1 1.1 M5.1 12.9 l1.1 -1.1 M11.8 6.2 l1.1 -1.1" />
    </svg>
  ),
};

const MODES = [
  { id: "day",      label: "Day",         glyph: "day" },
  { id: "preplan",  label: "Pre-plan",    glyph: "preplan" },
  { id: "plan",     label: "Plan",        glyph: "plan" },
  { id: "demo",     label: "Demo",        glyph: "demo" },
  { id: "retro",    label: "Retro",       glyph: "retro" },
];

// Display names for the things on the schedule (what each mode represents)
const SCHEDULE_DISPLAY = {
  day: "Daily",
  preplan: "Pre-planning",
  plan: "Planning",
  demo: "Demo",
  retro: "Retro",
};

// ---------- atoms ----------
const Mono = ({ children, className = "", style }) => (
  <span className={`mono ${className}`} style={style}>{children}</span>
);

// ---------- BIT 1a — top-bar mode tabs ----------
function ModeTabs({ active, suggested, onPick, onOpenSchedule }) {
  const [shimmer, setShimmer] = useState(true);
  useEffect(() => {
    // one-shot — let the animation play, then strip the class so it's truly static after.
    const t = setTimeout(() => setShimmer(false), 700);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="s4a-tabs" role="tablist" aria-label="workspace mode">
      {MODES.map((m, i) => {
        const isActive = m.id === active;
        const isSug = !isActive && m.id === suggested;
        return (
          <button
            key={m.id}
            role="tab"
            aria-selected={isActive}
            className={`s4a-tab ${isActive ? "is-active" : ""} ${isSug ? "is-suggested" : ""} ${isSug && shimmer ? "shimmer-on" : ""}`}
            onClick={() => onPick(m.id)}
          >
            <span className="glyph">{Glyph[m.glyph]}</span>
            <span>{m.label}</span>
            {isSug && <span className="sug-dot" aria-label="suggested mode" />}
          </button>
        );
      })}
      <span className="s4a-tabs-sep" />
      <span className="s4a-tabs-hint">
        <span style={{ color: "var(--accent)" }}>›</span>&nbsp;Switch to Pre-plan?
        <button className="gear" onClick={onOpenSchedule}>
          <span style={{ width: 12, height: 12, display: "inline-flex" }}>{Glyph.gear}</span>
          schedule
        </button>
      </span>
    </div>
  );
}

// ---------- BIT 1b — left-rail mode column ----------
function ModeRail({ active, suggested, onPick, onOpenSchedule }) {
  const [shimmer, setShimmer] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShimmer(false), 700);
    return () => clearTimeout(t);
  }, []);

  return (
    <nav className="s4a-rail" aria-label="workspace mode">
      <div className="s4a-rail-cap">MODE</div>
      {MODES.map((m) => {
        const isActive = m.id === active;
        const isSug = !isActive && m.id === suggested;
        return (
          <button
            key={m.id}
            className={`s4a-rail-tile ${isActive ? "is-active" : ""} ${isSug ? "is-suggested" : ""} ${isSug && shimmer ? "shimmer-on" : ""}`}
            onClick={() => onPick(m.id)}
            aria-pressed={isActive}
            title={m.label}
          >
            <span className="glyph">{Glyph[m.glyph]}</span>
            <span className="lbl">{m.label}</span>
            {isSug && <span className="sug-dot" aria-label="suggested mode" />}
          </button>
        );
      })}
      <div className="s4a-rail-sep" />
      <button className="s4a-rail-gear" onClick={onOpenSchedule} title="Ceremony schedule">
        <span className="glyph" style={{ width: 16, height: 16, display: "inline-flex" }}>{Glyph.gear}</span>
        <span className="lbl">Schedule</span>
      </button>
    </nav>
  );
}

// ---------- BIT 2 — "Up next" tile ----------
function UpNextTile({ imminent, onOpenSchedule, onJump }) {
  // imminent = within ~15 min window OR overdue (sample data: Pre-planning started 32 min ago)
  return (
    <button
      className={`s4a-tile ${imminent ? "is-imminent" : ""}`}
      onClick={onJump}
    >
      <div className="s4a-tile-head">
        <span className="s4a-tile-flag">
          <span className="dot" style={{ width: 5, height: 5, borderRadius: "50%", background: imminent ? "var(--accent)" : "var(--ink-3)", display: "inline-block" }} />
          {imminent ? "UP NEXT · PRE-PLANNING" : "UP NEXT · DAILY"}
        </span>
        <span
          className="s4a-tile-gear"
          onClick={(e) => { e.stopPropagation(); onOpenSchedule(); }}
          role="button"
          tabIndex={0}
          aria-label="edit schedule"
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onOpenSchedule(); } }}
        >
          <span style={{ width: 13, height: 13, display: "inline-flex" }}>{Glyph.gear}</span>
        </span>
      </div>
      <h4 className="s4a-tile-name">
        {imminent ? "Pre-planning" : "Daily"}
      </h4>
      <div className="s4a-tile-when">
        <span className="time">14:00</span>
        <span className="rel">{imminent ? "started 32 min ago" : "in 23 min"}</span>
      </div>
      <div className="s4a-tile-peek">
        <span className="v">Demo</span> Fri <Mono>11:00</Mono>
        &nbsp;·&nbsp; <span className="v">Retro</span> Fri <Mono>13:00</Mono>
      </div>
    </button>
  );
}

// ---------- BIT 3 — ceremony schedule modal ----------
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const WEEKS = [1, 2];

function PillSelect({ value, options, format = (v) => v }) {
  // Static visual pill — interactive popover is out of scope for the mockup.
  return (
    <button className="s4a-pill" type="button">
      <span>{format(value)}</span>
      <span className="chev">▾</span>
    </button>
  );
}

function TimeInput({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const commit = () => {
    setEditing(false);
    if (/^\d{1,2}:\d{2}$/.test(draft)) onChange?.(draft);
    else setDraft(value);
  };
  return editing ? (
    <input
      className="s4a-time"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setEditing(false); setDraft(value); }
      }}
      autoFocus
      inputMode="numeric"
      placeholder="HH:MM"
    />
  ) : (
    <button className="s4a-time" type="button" onClick={() => setEditing(true)} title="click to edit">
      {value}
    </button>
  );
}

const INITIAL_SCHEDULE = [
  { id: "daily",    name: "Daily",        cadence: "weekdays",   day: null,         time: "09:00", week: null, enabled: true },
  { id: "preplan",  name: "Pre-planning", cadence: "per-sprint", day: "Wednesday",  time: "14:00", week: 2,    enabled: true },
  { id: "plan",     name: "Planning",     cadence: "per-sprint", day: "Monday",     time: "09:00", week: 1,    enabled: true },
  { id: "demo",     name: "Demo",         cadence: "per-sprint", day: "Friday",     time: "11:00", week: 2,    enabled: true },
  { id: "retro",    name: "Retro",        cadence: "per-sprint", day: "Friday",     time: "13:00", week: 2,    enabled: true },
];

function ScheduleModal({ open, onClose, onSave }) {
  const [rows, setRows] = useState(INITIAL_SCHEDULE);
  if (!open) return null;
  const update = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="s4a-modal-scrim" role="dialog" aria-modal="true" aria-labelledby="s4a-mod-title" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="s4a-modal">
        <header className="s4a-modal-head">
          <div className="text">
            <h2 className="s4a-modal-title" id="s4a-mod-title">Schedule</h2>
            <p className="s4a-modal-sub">When does each thing happen? You can edit this anytime.</p>
          </div>
          <button className="s4a-modal-close" onClick={onClose} aria-label="close">✕</button>
        </header>
        <div className="s4a-modal-body">
          {rows.map((r) => (
            <div key={r.id} className={`s4a-cere-row ${r.enabled ? "" : "is-disabled"}`}>
              <div className="s4a-cere-name">{r.name.toUpperCase()}</div>
              <div className="s4a-cere-fields">
                {r.cadence === "weekdays" ? (
                  <span className="static-label">weekdays</span>
                ) : (
                  <>
                    <PillSelect value={r.day} options={DAYS} />
                    <span className="label">week</span>
                    <PillSelect value={r.week} options={WEEKS} />
                  </>
                )}
                <span className="label">at</span>
                <TimeInput value={r.time} onChange={(v) => update(r.id, { time: v })} />
              </div>
              <button
                className={`s4a-toggle ${r.enabled ? "is-on" : ""}`}
                onClick={() => update(r.id, { enabled: !r.enabled })}
                aria-pressed={r.enabled}
                aria-label={r.enabled ? "disable" : "enable"}
              />
            </div>
          ))}
        </div>
        <footer className="s4a-modal-foot">
          <p className="s4a-modal-foot-note">
            Outlook integration coming soon — once you connect Outlook, these times can auto-fill from your calendar.
          </p>
          <div className="s4a-modal-foot-actions">
            <button className="s4a-btn-ghost" onClick={onClose}>Cancel</button>
            <button className="s4a-btn-accent" onClick={() => { onSave?.(rows); onClose(); }}>Save</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------- shell — dashboard top region + sidebar + content peek ----------
function DashboardShell({ kind, modalOpen, setModalOpen }) {
  const [active, setActive] = useState("day");
  const suggested = "preplan"; // sample data says Wed 14:32, pre-planning overdue

  return (
    <div className={`s4a ${kind === "rail" ? "has-rail" : ""}`} data-screen-label={kind === "rail" ? "02 Variation B · left rail" : "01 Variation A · top tabs"}>
      <div className="s4a-glow s4a-glow-1" aria-hidden="true" />
      <div className="s4a-glow s4a-glow-2" aria-hidden="true" />

      <div className="s4a-cap">
        <span className="label">
          {kind === "rail" ? "Variation B — left-rail mode column" : "Variation A — top-bar mode tabs"}
        </span>
        <span className="desc">
          {kind === "rail"
            ? "Slim 64px rail on the far left · icon + label per mode · accent left-border on active · top bar stays clean"
            : "Pill group sits below the top bar · active is filled accent · suggested gets shimmer + dot · top bar carries only sprint info"}
        </span>
      </div>

      {/* TOP BAR — shared */}
      <header className="s4a-top">
        <div className="s4a-brand">
          <span className="s4a-brand-mark" aria-hidden="true" />
          <span className="s4a-brand-name">SPRINT&nbsp;HELPER</span>
          <span className="s4a-brand-meta"><Mono>moran</Mono></span>
        </div>
        <div className="s4a-top-right">
          <span className="s4a-sprint-pick">
            <span className="arr">←</span>
            <Mono style={{ color: "var(--ink-0)" }}>26_11</Mono>
            <span className="arr">→</span>
          </span>
          <span className="s4a-info-chip">
            <span>DAY <Mono className="clock">4/10</Mono></span>
            <span className="sep" />
            <span>LOCAL <Mono className="clock">14:32</Mono></span>
          </span>
          <span className="s4a-sync-pill">
            <span className="dot" /> live
          </span>
        </div>
      </header>

      {/* Mode tabs (variation A only, between top bar and body) */}
      {kind === "tabs" && (
        <ModeTabs
          active={active}
          suggested={suggested}
          onPick={setActive}
          onOpenSchedule={() => setModalOpen(true)}
        />
      )}

      <div className="s4a-body">
        {/* Mode rail (variation B only — first column of body) */}
        {kind === "rail" && (
          <ModeRail
            active={active}
            suggested={suggested}
            onPick={setActive}
            onOpenSchedule={() => setModalOpen(true)}
          />
        )}

        <aside className="s4a-side">
          <div className="s4a-date">WEDNESDAY · WEEK 2 OF SPRINT 26_11</div>
          <h1 className="s4a-greet">
            Good afternoon,<br />
            <b>Moran</b>
          </h1>
          <p className="s4a-sub">
            Pre-planning was meant to start at 14:00 — head over when you're ready.
            Three tasks are still going in the background.
          </p>

          {/* Up next tile */}
          <UpNextTile
            imminent
            onOpenSchedule={() => setModalOpen(true)}
            onJump={() => setActive("preplan")}
          />
        </aside>

        <section className="s4a-content">
          <article className="s4a-card">
            <div className="s4a-card-head">
              <span className="s4a-card-flag">
                <span className="dot" /> ACTIVE STORY
              </span>
              <Mono className="s4a-card-id">#426267</Mono>
            </div>
            <h2 className="s4a-card-title">CODEOWNERS model — automate routing</h2>
            <div className="s4a-card-numbers">
              <div className="s4a-num">
                <span className="s4a-num-cap">LOGGED</span>
                <span className="s4a-num-val">2h 15m</span>
              </div>
              <div className="s4a-num">
                <span className="s4a-num-cap">ESTIMATE</span>
                <span className="s4a-num-val">6h</span>
              </div>
              <div className="s4a-num">
                <span className="s4a-num-cap">REMAINING</span>
                <span className="s4a-num-val">3h 45m</span>
              </div>
            </div>
          </article>

          <div>
            <div className="s4a-tasks-head">
              <span className="title-cap">TASKS</span>
              <span className="meta">3 assigned · 1 going · 2 waiting</span>
            </div>
            <div className="s4a-task-row going">
              <span className="id">#426268</span>
              <span className="title">Wire ADO PATCH effort</span>
              <Mono className="meta">1h 23m / 4h</Mono>
              <span className="state">GOING</span>
            </div>
            <div className="s4a-task-row">
              <span className="id">#426269</span>
              <span className="title">Test against staging org</span>
              <Mono className="meta">0h / 2h</Mono>
              <span className="state">WAITING</span>
            </div>
            <div className="s4a-task-row">
              <span className="id">#426270</span>
              <span className="title">Update CODEOWNERS docs</span>
              <Mono className="meta">0h 52m / 1.5h</Mono>
              <span className="state">WAITING</span>
            </div>
          </div>
        </section>
      </div>

      <ScheduleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}

// ---------- exported variations ----------
function VariationTabs({ withModal = true }) {
  const [open, setOpen] = useState(withModal);
  return <DashboardShell kind="tabs" modalOpen={open} setModalOpen={setOpen} />;
}
function VariationRail({ withModal = true }) {
  const [open, setOpen] = useState(withModal);
  return <DashboardShell kind="rail" modalOpen={open} setModalOpen={setOpen} />;
}

window.S4ATabs = VariationTabs;
window.S4ARail = VariationRail;
window.S4ATabsNoModal = () => <VariationTabs withModal={false} />;
window.S4ARailNoModal = () => <VariationRail withModal={false} />;
