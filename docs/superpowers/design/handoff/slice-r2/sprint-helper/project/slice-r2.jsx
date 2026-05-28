/* global React */
const { useState } = React;

// ============================================================
// data
// ============================================================

const SPRINT = { id: "26_11", day: 4, total: 12, weekday: "Wednesday", clock: "14:32" };
const USER = "moran";

const CAPACITY = {
  logged: "37h",
  estimate: "12h",
  remaining: "12h",
  going: 4,
  waiting: 14,
};

// 6 stories — the live one is #434964
const STORIES = [
  { id: "431995", kind: "User Story", title: "Design: devex-infrastructure — Repository Structure, Schema, and ApplicationSets", going: 2, waiting: 0, done: 0, live: false },
  { id: "434963", kind: "Feature",    title: "[Cluster-Addons] Prod cluster onboarding",                                            going: 0, waiting: 0, done: 0, sub: "feature · 1 task", live: false },
  { id: "434964", kind: "User Story", title: "Deploy ArgoCD to prod cluster",                                                       going: 1, waiting: 1, done: 0, live: true },
  { id: "434966", kind: "User Story", title: "Validate addon rollout from prod ArgoCD across clusters",                             going: 0, waiting: 4, done: 0, live: false },
  { id: "434965", kind: "User Story", title: "Create prod cluster-addons repo + bootstrap into prod ArgoCD",                        going: 0, waiting: 4, done: 0, live: false },
  { id: "426271", kind: "Discovery",  title: "ArgoCD ApplicationSet Design",                                                        going: 0, waiting: 1, done: 0, live: false },
];

// Focal live task
const LIVE_TASK = {
  id: "432010",
  title: "Flip deployArgoCD to true + add prod values",
  parent: { id: "434964", title: "Deploy ArgoCD to prod cluster" },
  startedAt: "14:18",
  logged: "2h",
  sittings: 2,
  estimate: "4h",
  remaining: "2h",
};

// Second live task (for the 2-sessions frame) — most recently started becomes
// the focal one; this older one shows up as "also live" secondary chip.
const LIVE_TASK_2 = {
  id: "432020",
  title: "Bootstrap prod cluster-addons repo",
  parent: { id: "434965", title: "Create prod cluster-addons repo + bootstrap into prod ArgoCD" },
  startedAt: "13:42",
  logged: "1h",
  sittings: 1,
};

// Activity feed for the focal task. Newest LAST stored, displayed newest FIRST.
const TASK_EVENTS_RAW = [
  { time: "13:55", type: "note",     body: "Synced from main; deploy branch is up to date" },
  { time: "14:08", type: "note",     body: "Skimmed staging values.yaml for diffs against prod target" },
  { time: "14:32", type: "focus",    body: "Picked up the prod ArgoCD install" },
  { time: "14:40", type: "decision", body: "Merge of deploy branch IS the install mechanism — no separate apply" },
  { time: "14:52", type: "blocker",  body: "Prod uses scoped policies, not cluster-admin — need narrower IAM" },
  { time: "15:05", type: "progress", body: "Confirmed EKS access entry + policies in place for the controller" },
];
const TASK_EVENTS = [...TASK_EVENTS_RAW].reverse();

// Recent items for the bottom Overview lists
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

function TimeTotal({ logged, sittings }) {
  const word = sittings === 1 ? "sitting" : "sittings";
  return (
    <Mono className="time-total">
      {logged} · {sittings} {word}
    </Mono>
  );
}

function TopBar({ live }) {
  return (
    <div className="sr2-top">
      <div className="sr2-brand">
        <span className="sr2-brand-mark" aria-hidden="true" />
        <span className="sr2-brand-name">SPRINT HELPER</span>
        <span className="sr2-brand-meta">{USER}</span>
      </div>
      <div className="sr2-top-right">
        <span className="sr2-pill"><span className="arr">‹</span><span className="v">{SPRINT.id}</span><span className="arr">›</span></span>
        <span className="sr2-pill">day <span className="v">{SPRINT.day}/{SPRINT.total}</span></span>
        <span className="sr2-pill is-strong"><span className="v">{SPRINT.clock}</span></span>
      </div>
    </div>
  );
}

function EventRow({ event }) {
  const labelByType = {
    focus: "Focus",
    progress: "Progress",
    blocker: "Blocker",
    decision: "Decision",
    note: "Note",
  };
  return (
    <div className="sr2-ev">
      <span className="sr2-ev-time">{event.time}</span>
      <span className={`sr2-ev-type t-${event.type}`}>{labelByType[event.type]}</span>
      <span className="sr2-ev-body">{event.body}</span>
    </div>
  );
}

function ActivityFeed({ events, meta }) {
  return (
    <div className="sr2-feed">
      <div className="sr2-feed-head">
        <span className="sr2-feed-title">Recent activity</span>
        <span className="sr2-feed-meta">{meta || `${events.length} entries · since ${LIVE_TASK.startedAt}`}</span>
      </div>
      <div className="sr2-feed-list">
        {events.map((e, i) => <EventRow key={i} event={e} />)}
      </div>
    </div>
  );
}

// ============================================================
// Overview state — shared between variations
// ============================================================

function StoryChip({ s }) {
  return (
    <article className={`sr2-storychip ${s.live ? "is-live" : ""}`}>
      <div className="sr2-storychip-head">
        <span className="sr2-storychip-kind">{s.kind}</span>
        <span className="sr2-storychip-id"><Mono>#{s.id}</Mono></span>
      </div>
      <h4 className="sr2-storychip-title">{s.title}</h4>
      <div className="sr2-storychip-counts">
        {s.going > 0 && <span className="c-going">{s.going} going</span>}
        {s.going > 0 && (s.waiting > 0 || s.done > 0) && <span className="sep">·</span>}
        {s.waiting > 0 && <span>{s.waiting} waiting</span>}
        {s.sub && (s.going === 0 && s.waiting === 0) && <span>{s.sub}</span>}
      </div>
    </article>
  );
}

function Overview({ withCaption = true, prompt }) {
  return (
    <>
      {withCaption && (
        <div className="sr2-cap">
          <span className="dot" /><span className="label">Overview</span>
          <span>· No session live · The calm board · {SPRINT.weekday} {SPRINT.clock}</span>
        </div>
      )}
      <TopBar />
      <div className="sr2-overview">
        <section>
          <div className="sr2-headline">
            <div className="sr2-headline-left">
              <div>
                <div className="sr2-headline-cap">REMAINING</div>
                <div className="sr2-headline-big">12<span className="unit">h</span></div>
              </div>
              <div className="sr2-headline-day">
                day <span className="v">{SPRINT.day}</span> of <span className="v">{SPRINT.total}</span>
              </div>
            </div>
            <div className="sr2-headline-right">
              <div className="sr2-headline-prompt">
                {prompt || (
                  <>
                    Nothing live —{" "}
                    <a href="#stories">pick something below</a>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="sr2-subline" style={{ marginTop: 18 }}>
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
          <div className="sr2-stories-head">
            <span className="sr2-stories-title">My stories</span>
            <span className="sr2-stories-meta">{STORIES.length} in sprint · click to focus</span>
          </div>
          <div className="sr2-stories-grid" style={{ marginTop: 14 }}>
            {STORIES.map((s) => <StoryChip key={s.id} s={s} />)}
          </div>
        </section>

        <section className="sr2-lists">
          <div className="sr2-list">
            <div className="sr2-list-head">
              <span className="sr2-list-title">For your daily</span>
              <span className="sr2-list-meta">auto-drafted · yesterday</span>
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
          <div className="sr2-list">
            <div className="sr2-list-head">
              <span className="sr2-list-title">In this sprint</span>
              <span className="sr2-list-meta">{CAPACITY.going + CAPACITY.waiting} open</span>
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
    </>
  );
}

// ============================================================
// Focus state — Variation A (Collapse)
// ============================================================

function FocusA({ sessions = 1 }) {
  const otherCount = STORIES.length - 1; // everything except the parent of the focal task
  const capLabel = sessions === 2
    ? "Focus · 2 sessions live · centred on the most recently started"
    : "Focus · 1 session live · the board collapsed to a strip";

  return (
    <>
      <div className="sr2-cap is-live">
        <span className="dot" /><span className="label">Focus</span>
        <span>· {capLabel}</span>
      </div>

      {/* thin strip — the rest of the board, collapsed */}
      <div className="sr2-strip">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">SPRINT HELPER</span>
        <span className="sep">·</span>
        <span>sprint <span className="v">{SPRINT.id}</span></span>
        <span className="sep">·</span>
        <span>day <span className="v">{SPRINT.day}/{SPRINT.total}</span></span>
        <span className="sep">·</span>
        <span><span className="v">{CAPACITY.remaining}</span> remaining</span>
        <span className="sep">·</span>
        <span><span className="v">{SPRINT.clock}</span></span>
        <button className="escape" title="Return to the calm board">
          {otherCount} more in sprint
          <span className="arr">↗</span>
        </button>
      </div>

      {/* the focal task */}
      <div className="sr2-focal">
        <div className="sr2-focal-context">
          <span className="kind">Story</span>
          <span className="sep">·</span>
          <a href={`#${LIVE_TASK.parent.id}`}>
            <span className="story-title">{LIVE_TASK.parent.title}</span>
          </a>
          <span className="sep">·</span>
          <Mono className="id">#{LIVE_TASK.parent.id}</Mono>
        </div>

        <div className="sr2-focal-id"><Mono>#{LIVE_TASK.id}</Mono></div>
        <h1 className="sr2-focal-title">{LIVE_TASK.title}</h1>

        <div className="sr2-focal-meta">
          <span className="live-pill">live</span>
          <span className="since">started <span className="v">{LIVE_TASK.startedAt}</span></span>
          <span className="grow" />
          <span className="num">
            <span className="cap">LOGGED</span>
            <span className="val"><Mono>{LIVE_TASK.logged}</Mono></span>
            <span className="sub">· {LIVE_TASK.sittings} sittings</span>
          </span>
          <span className="num">
            <span className="cap">ESTIMATE</span>
            <span className="val"><Mono>{LIVE_TASK.estimate}</Mono></span>
          </span>
          <span className="num">
            <span className="cap">REMAINING</span>
            <span className="val"><Mono>{LIVE_TASK.remaining}</Mono></span>
          </span>
        </div>

        {sessions === 2 && (
          <button className="sr2-also" title="Make this the focus instead">
            <span className="cap">ALSO LIVE</span>
            <span className="t">{LIVE_TASK_2.title}</span>
            <span className="arr">→</span>
          </button>
        )}

        <ActivityFeed events={TASK_EVENTS} meta={`${TASK_EVENTS.length} entries · since ${LIVE_TASK.startedAt}`} />
      </div>
    </>
  );
}

// ============================================================
// Focus state — Variation B (Recede behind)
// ============================================================

function FocusB({ sessions = 1 }) {
  const capLabel = sessions === 2
    ? "Focus · 2 sessions live · centred on the most recently started"
    : "Focus · 1 session live · the board recedes behind a calm panel";
  return (
    <>
      <div className="sr2-cap is-live">
        <span className="dot" /><span className="label">Focus</span>
        <span>· {capLabel}</span>
      </div>

      <div className="sr2-focus-b">
        {/* dimmed board behind */}
        <div className="sr2-behind" aria-hidden="true">
          <Overview withCaption={false} />
        </div>

        {/* centred panel on top */}
        <div className="sr2-panel-wrap">
          <div className="sr2-panel">
            <div className="sr2-focal-context">
              <span className="kind">Story</span>
              <span className="sep">·</span>
              <a href={`#${LIVE_TASK.parent.id}`}>
                <span className="story-title">{LIVE_TASK.parent.title}</span>
              </a>
              <span className="sep">·</span>
              <Mono className="id">#{LIVE_TASK.parent.id}</Mono>
            </div>

            <div className="sr2-focal-id"><Mono>#{LIVE_TASK.id}</Mono></div>
            <h1 className="sr2-focal-title">{LIVE_TASK.title}</h1>

            <div className="sr2-focal-meta">
              <span className="live-pill">live</span>
              <span className="since">started <span className="v">{LIVE_TASK.startedAt}</span></span>
              <span className="grow" />
              <span className="num">
                <span className="cap">LOGGED</span>
                <span className="val"><Mono>{LIVE_TASK.logged}</Mono></span>
                <span className="sub">· {LIVE_TASK.sittings} sittings</span>
              </span>
              <span className="num">
                <span className="cap">EST</span>
                <span className="val"><Mono>{LIVE_TASK.estimate}</Mono></span>
              </span>
              <span className="num">
                <span className="cap">REM</span>
                <span className="val"><Mono>{LIVE_TASK.remaining}</Mono></span>
              </span>
            </div>

            {sessions === 2 && (
              <button className="sr2-also" title="Make this the focus instead">
                <span className="cap">ALSO LIVE</span>
                <span className="t">{LIVE_TASK_2.title}</span>
                <span className="arr">→</span>
              </button>
            )}

            <ActivityFeed events={TASK_EVENTS} meta={`${TASK_EVENTS.length} entries · since ${LIVE_TASK.startedAt}`} />
          </div>
        </div>

        {/* quiet escape */}
        <button className="sr2-escape-b">
          <span className="arr">↗</span>
          show the whole board
        </button>
      </div>
    </>
  );
}

// ============================================================
// Frame wrapper
// ============================================================

function Frame({ children, label }) {
  return (
    <div className="sr2" data-screen-label={label}>
      {children}
    </div>
  );
}

// ============================================================
// Exports for the canvas
// ============================================================

window.OverviewFrame = () => (
  <Frame label="Overview"><Overview /></Frame>
);

window.FocusACollapseFrame = () => (
  <Frame label="Focus A · collapse · 1 session"><FocusA sessions={1} /></Frame>
);

window.FocusACollapseTwoFrame = () => (
  <Frame label="Focus A · collapse · 2 sessions"><FocusA sessions={2} /></Frame>
);

window.FocusBRecedeFrame = () => (
  <Frame label="Focus B · recede · 1 session"><FocusB sessions={1} /></Frame>
);

window.FocusBRecedeTwoFrame = () => (
  <Frame label="Focus B · recede · 2 sessions"><FocusB sessions={2} /></Frame>
);
