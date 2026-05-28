/* global React */
const { useState } = React;
const { useTweaks, TweaksPanel, TweakSection, TweakRadio } = window;

// ============================================================
// data (same as r2, kept inline so this slice stands alone)
// ============================================================

const SPRINT = { id: "26_11", day: 4, total: 12, weekday: "Wednesday", clock: "14:32" };
const USER = "moran";

const CAPACITY = { logged: "37h", estimate: "12h", remaining: "12h", going: 4, waiting: 14 };

const STORIES = [
  { id: "431995", kind: "User Story", title: "Design: devex-infrastructure — Repository Structure, Schema, and ApplicationSets", going: 2, waiting: 0, done: 0, live: false },
  { id: "434963", kind: "Feature",    title: "[Cluster-Addons] Prod cluster onboarding",                                            going: 0, waiting: 0, done: 0, sub: "feature · 1 task", live: false },
  { id: "434964", kind: "User Story", title: "Deploy ArgoCD to prod cluster",                                                       going: 1, waiting: 1, done: 0, live: true },
  { id: "434966", kind: "User Story", title: "Validate addon rollout from prod ArgoCD across clusters",                             going: 0, waiting: 4, done: 0, live: false },
  { id: "434965", kind: "User Story", title: "Create prod cluster-addons repo + bootstrap into prod ArgoCD",                        going: 0, waiting: 4, done: 0, live: false },
  { id: "426271", kind: "Discovery",  title: "ArgoCD ApplicationSet Design",                                                        going: 0, waiting: 1, done: 0, live: false },
];

const LIVE_TASK = {
  id: "432010",
  title: "Flip deployArgoCD to true + add prod values",
  parent: { id: "434964", title: "Deploy ArgoCD to prod cluster" },
  startedAt: "14:18",
  logged: "2h", sittings: 2, estimate: "4h", remaining: "2h",
};
const LIVE_TASK_2 = {
  id: "432020",
  title: "Bootstrap prod cluster-addons repo",
  parent: { id: "434965", title: "Create prod cluster-addons repo + bootstrap into prod ArgoCD" },
};

const TASK_EVENTS_RAW = [
  { time: "13:55", type: "note",     body: "Synced from main; deploy branch is up to date" },
  { time: "14:08", type: "note",     body: "Skimmed staging values.yaml for diffs against prod target" },
  { time: "14:32", type: "focus",    body: "Picked up the prod ArgoCD install" },
  { time: "14:40", type: "decision", body: "Merge of deploy branch IS the install mechanism — no separate apply" },
  { time: "14:52", type: "blocker",  body: "Prod uses scoped policies, not cluster-admin — need narrower IAM" },
  { time: "15:05", type: "progress", body: "Confirmed EKS access entry + policies in place for the controller" },
];
const TASK_EVENTS = [...TASK_EVENTS_RAW].reverse();

const DAILY_NOTES = [
  { id: "434973", t: "devex-argofleet supporting work (rename + cleanup)" },
  { id: "434969", t: "EKS access entry + ArgoCD cluster/ns policies" },
  { id: "434968", t: "Register prod cluster in fleet inventory" },
];
const IN_SPRINT = [
  { id: "434970", t: "Per-cluster ArgoCD values + flip deployArgoCD=true" },
  { id: "434972", t: "Document install policy decisions for the DR runbook" },
  { id: "434974", t: "Confirm addon rollout against staging baseline" },
];

// ============================================================
// atoms
// ============================================================

const Mono = ({ children, style, className }) => (
  <span className={`mono ${className || ""}`} style={style}>{children}</span>
);

const EVENT_LABELS = {
  focus: "Focus", progress: "Progress", blocker: "Blocker",
  decision: "Decision", note: "Note",
};

function EventRow({ event }) {
  return (
    <div className="r21-ev">
      <span className="r21-ev-time">{event.time}</span>
      <span className={`r21-ev-type t-${event.type}`}>{EVENT_LABELS[event.type]}</span>
      <span className="r21-ev-body">{event.body}</span>
    </div>
  );
}

// ============================================================
// TOP BAR — two layers
// ============================================================

function TopBarOverview() {
  return (
    <div className="r21-top is-overview">
      <div className="r21-brand">
        <span className="r21-brand-mark" aria-hidden="true" />
        <span className="r21-brand-name">SPRINT HELPER</span>
        <span className="r21-brand-meta">{USER}</span>
      </div>
      <div className="r21-top-right">
        <span className="r21-pill"><span className="arr">‹</span><span className="v">{SPRINT.id}</span><span className="arr">›</span></span>
        <span className="r21-pill">day <span className="v">{SPRINT.day}/{SPRINT.total}</span></span>
        <span className="r21-pill"><span className="v">{SPRINT.clock}</span></span>
      </div>
    </div>
  );
}

function TopBarFocus({ onEscape, otherCount }) {
  return (
    <div className="r21-top is-focus">
      <div className="r21-brand">
        <span className="r21-brand-mark" aria-hidden="true" />
        <span className="r21-brand-name">SPRINT HELPER</span>
        <span className="r21-strip-meta">
          <span className="sep">·</span>
          <span>sprint <span className="v">{SPRINT.id}</span></span>
          <span className="sep">·</span>
          <span>day <span className="v">{SPRINT.day}/{SPRINT.total}</span></span>
          <span className="sep">·</span>
          <span><span className="v">{CAPACITY.remaining}</span> remaining</span>
          <span className="sep">·</span>
          <span><span className="v">{SPRINT.clock}</span></span>
        </span>
      </div>
      <button className="r21-escape" onClick={onEscape} title="Return to the calm board (your work keeps logging)">
        <span><span className="v">{otherCount}</span> more in sprint</span>
        <span className="arr">↗</span>
      </button>
    </div>
  );
}

// ============================================================
// OVERVIEW body
// ============================================================

function StoryChip({ s, onClick }) {
  return (
    <article className={`r21-storychip ${s.live ? "is-live" : ""}`} onClick={onClick}>
      <div className="r21-storychip-head">
        <span className="r21-storychip-kind">{s.kind}</span>
        <span className="r21-storychip-id"><Mono>#{s.id}</Mono></span>
      </div>
      <h4 className="r21-storychip-title">{s.title}</h4>
      <div className="r21-storychip-counts">
        {s.going > 0 && <span className="c-going">{s.going} going</span>}
        {s.going > 0 && (s.waiting > 0) && <span className="sep">·</span>}
        {s.waiting > 0 && <span>{s.waiting} waiting</span>}
        {s.sub && (s.going === 0 && s.waiting === 0) && <span>{s.sub}</span>}
      </div>
    </article>
  );
}

function Overview({ live, onStartLive }) {
  return (
    <div className="r21-overview">
      <section>
        <div className="r21-headline">
          <div className="r21-headline-left">
            <div>
              <div className="r21-headline-cap">REMAINING</div>
              <div className="r21-headline-big">12<span className="unit">h</span></div>
            </div>
            <div className="r21-headline-day">
              day <span className="v">{SPRINT.day}</span> of <span className="v">{SPRINT.total}</span>
            </div>
          </div>
          <div className="r21-headline-prompt">
            {live
              ? <>Last on: <span className="v">{LIVE_TASK.title}</span></>
              : <>Nothing live — <a href="#stories">pick something below</a></>}
          </div>
        </div>
        <div className="r21-subline">
          <span><span className="v">{CAPACITY.logged}</span> logged this sprint</span>
          <span className="sep">·</span>
          <span><span className="v">{CAPACITY.estimate}</span> estimate</span>
          <span className="sep">·</span>
          <span><span className="v">{CAPACITY.going}</span> going</span>
          <span className="sep">·</span>
          <span><span className="v">{CAPACITY.waiting}</span> waiting</span>
        </div>
      </section>

      <section>
        <div className="r21-stories-head">
          <span className="r21-stories-title">My stories</span>
          <span className="r21-stories-meta">{STORIES.length} in sprint · click to focus</span>
        </div>
        <div className="r21-stories-grid">
          {STORIES.map((s) => (
            <StoryChip key={s.id} s={s} onClick={s.live ? onStartLive : undefined} />
          ))}
        </div>
      </section>

      <section className="r21-lists">
        <div className="r21-list">
          <div className="r21-list-head">
            <span className="r21-list-title">For your daily</span>
            <span className="r21-list-meta">auto-drafted · yesterday</span>
          </div>
          <ul>
            {DAILY_NOTES.map((d) => (
              <li key={d.id}>
                <Mono className="id">closed #{d.id}</Mono>
                <span className="t">{d.t}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="r21-list">
          <div className="r21-list-head">
            <span className="r21-list-title">In this sprint</span>
            <span className="r21-list-meta">{CAPACITY.going + CAPACITY.waiting} open</span>
          </div>
          <ul>
            {IN_SPRINT.map((d) => (
              <li key={d.id}>
                <Mono className="id">#{d.id}</Mono>
                <span className="t">{d.t}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

// ============================================================
// FOCUS body
// ============================================================

function Focus({ twoSessions, onPromoteSecondary }) {
  return (
    <div className="r21-focal">
      <div className="r21-focal-context">
        <a href={`#${LIVE_TASK.parent.id}`}>
          <span className="kind">Story</span>
          <span className="sep">·</span>
          <span className="story-title">{LIVE_TASK.parent.title}</span>
          <span className="sep">·</span>
          <Mono className="id">#{LIVE_TASK.parent.id}</Mono>
        </a>
      </div>

      <div className="r21-focal-id"><Mono>#{LIVE_TASK.id}</Mono></div>
      <h1 className="r21-focal-title">{LIVE_TASK.title}</h1>

      <div className="r21-focal-meta">
        <span className="r21-live-pill">live</span>
        <span className="r21-since">started <span className="v">{LIVE_TASK.startedAt}</span></span>
        <span className="r21-grow" />
        <span className="r21-num">
          <span className="cap">LOGGED</span>
          <span className="val">{LIVE_TASK.logged}</span>
          <span className="sub">· {LIVE_TASK.sittings} sittings</span>
        </span>
        <span className="r21-num">
          <span className="cap">ESTIMATE</span>
          <span className="val">{LIVE_TASK.estimate}</span>
        </span>
        <span className="r21-num">
          <span className="cap">REMAINING</span>
          <span className="val">{LIVE_TASK.remaining}</span>
        </span>
      </div>

      {twoSessions && (
        <button className="r21-also" onClick={onPromoteSecondary} title="Make this the focus instead">
          <span className="cap">ALSO LIVE</span>
          <span className="t">{LIVE_TASK_2.title}</span>
          <span className="arr">→</span>
        </button>
      )}

      <div className="r21-feed">
        <div className="r21-feed-head">
          <span className="r21-feed-title">Recent activity</span>
          <span className="r21-feed-meta">{TASK_EVENTS.length} entries · since {LIVE_TASK.startedAt}</span>
        </div>
        <div className="r21-feed-list">
          {TASK_EVENTS.map((e, i) => <EventRow key={i} event={e} />)}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// LEFT SIDEBAR — greeting + up next + mini sprint week
// ============================================================

const SIDE_WEEK = [
  { d: "M", n: 25, state: "is-past" },
  { d: "T", n: 26, state: "is-past" },
  { d: "W", n: 27, state: "is-today" },
  { d: "T", n: 28, state: "is-future" },
  { d: "F", n: 29, state: "is-future" },
  { d: "S", n: 30, state: "is-weekend" },
  { d: "S", n: 31, state: "is-weekend" },
];

function Sidebar() {
  return (
    <div className="r21-sidewrap">
      <aside className="r21-side">
        <div className="r21-side-date">Wednesday · May 27</div>
        <h1 className="r21-side-greet">Good afternoon, <b>Moran</b></h1>
        <p className="r21-side-sub">{CAPACITY.going} tasks in progress. {SPRINT.total - SPRINT.day} days left in the sprint — start with whichever is most urgent.</p>

        <div className="r21-side-card">
          <span className="cap">Up next · Daily</span>
          <div className="row">
            <span className="when"><Mono>09:00</Mono></span>
            <span className="rel">in 18h 28m</span>
          </div>
          <span className="name">Daily standup</span>
        </div>

        <div className="r21-side-week">
          <div className="r21-side-week-head">
            <span>Sprint <span className="day"><Mono>{SPRINT.id}</Mono></span></span>
            <span>day <span className="day"><Mono>{SPRINT.day}/{SPRINT.total}</Mono></span></span>
          </div>
          <div className="r21-side-week-grid">
            {SIDE_WEEK.map((c, i) => (
              <span key={i} className={`r21-side-week-cell ${c.state}`}>{c.d}</span>
            ))}
            {SIDE_WEEK.map((c, i) => (
              <span key={`n${i}`} className={`r21-side-week-cell ${c.state}`}>{c.n}</span>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

// ============================================================
// MODE RAIL — app-level nav (persists across modes)
// ============================================================

const MODES = [
  { id: "day",      label: "Day",      glyph: <circle cx="7" cy="7" r="3" fill="currentColor" /> },
  { id: "pre-plan", label: "Pre-plan", glyph: <><rect x="2" y="3" width="10" height="8" rx="1" stroke="currentColor" fill="none" /><line x1="2" y1="6" x2="12" y2="6" stroke="currentColor" /></> },
  { id: "plan",     label: "Plan",     glyph: <><line x1="2" y1="4" x2="12" y2="4" stroke="currentColor" /><line x1="2" y1="7" x2="10" y2="7" stroke="currentColor" /><line x1="2" y1="10" x2="11" y2="10" stroke="currentColor" /></> },
  { id: "demo",     label: "Demo",     glyph: <polygon points="4,3 4,11 12,7" fill="currentColor" /> },
  { id: "retro",    label: "Retro",    glyph: <path d="M 11 7 A 4 4 0 1 1 7 3" stroke="currentColor" fill="none" strokeWidth="1.2" /> },
];

function ModeRail({ active = "day", onPick }) {
  return (
    <nav className="r21-rail" aria-label="Mode">
      <span className="r21-rail-cap">Mode</span>
      {MODES.map((m) => (
        <button
          key={m.id}
          className={`r21-rail-tile ${active === m.id ? "is-active" : ""}`}
          onClick={() => onPick && onPick(m.id)}
          title={m.label}
        >
          <span className="glyph" aria-hidden="true">
            <svg viewBox="0 0 14 14">{m.glyph}</svg>
          </span>
          <span className="lbl">{m.label}</span>
        </button>
      ))}
      <button className="r21-rail-gear" title="Retro shortcuts">
        <span className="glyph" aria-hidden="true">
          <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="3" stroke="currentColor" fill="none" /><circle cx="7" cy="7" r="1" fill="currentColor" /></svg>
        </span>
        <span className="lbl">Retro</span>
      </button>
    </nav>
  );
}

// ============================================================
// SESSION SIMULATOR — dev-only toggle
// ============================================================

function SessionSim({ sessions, setSessions }) {
  return (
    <div className="r21-sim" role="region" aria-label="Session simulator (dev only)">
      <span className="lbl">SESSION SIM</span>
      <div className="seg">
        <button className={sessions === 0 ? "is-on" : ""} onClick={() => setSessions(0)}>none</button>
        <button className={sessions === 1 ? "is-on" : ""} onClick={() => setSessions(1)}>1 live</button>
        <button className={sessions === 2 ? "is-on" : ""} onClick={() => setSessions(2)}>2 live</button>
      </div>
    </div>
  );
}

// ============================================================
// APP
// ============================================================

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "standard",
  "focal": "standard",
  "feed": "ruled"
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  // sessions: 0 = overview, 1 = focus, 2 = focus + secondary
  const [sessions, setSessions] = useState(1);
  const isFocus = sessions > 0;
  const otherCount = STORIES.length - 1;

  return (
    <div
      className={`r21-app ${isFocus ? "is-focus" : "is-overview"}`}
      data-density={t.density}
      data-focal={t.focal}
      data-feed={t.feed}
    >
      <ModeRail active="day" />
      <Sidebar />
      <div className="r21-main">
      <div className="r21-topwrap">
        <TopBarOverview />
        <TopBarFocus
          onEscape={() => setSessions(0)}
          otherCount={otherCount}
        />
      </div>

      <div className="r21-bodywrap">
        <div className="r21-body is-overview" aria-hidden={isFocus}>
          <Overview live={isFocus} onStartLive={() => setSessions(1)} />
        </div>
        <div className="r21-body is-focus" aria-hidden={!isFocus}>
          <Focus twoSessions={sessions === 2} onPromoteSecondary={() => { /* swap focus (mock) */ }} />
        </div>
      </div>
      </div>
      <SessionSim sessions={sessions} setSessions={setSessions} />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Density" />
        <TweakRadio
          label="Spacing"
          value={t.density}
          options={["compact", "standard", "generous"]}
          onChange={(v) => setTweak("density", v)}
        />

        <TweakSection label="Focal weight" />
        <TweakRadio
          label="How forcefully Focus takes over"
          value={t.focal}
          options={["whisper", "standard", "tunnel"]}
          onChange={(v) => setTweak("focal", v)}
        />

        <TweakSection label="Activity feed" />
        <TweakRadio
          label="Row style"
          value={t.feed}
          options={["ruled", "journal", "stream"]}
          onChange={(v) => setTweak("feed", v)}
        />
      </TweaksPanel>
    </div>
  );
}

window.SprintHelperR21A = App;
