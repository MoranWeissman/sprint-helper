/* global React */
const { useState, useEffect } = React;

// ---------- shared data ----------
const data = {
  date: "Thursday, May 26",
  sprint: { num: 42, day: 6, total: 10 },
  syncedMinAgo: 2,
  user: "Moran",
  running: [
    {
      id: "4530",
      title: "Fix prod hotfix for login bug",
      story: "Auth · Sprint 42",
      elapsedSec: 1 * 3600 + 12 * 60 + 4,
      estimateMin: 120,
      started: "11:47",
      focused: true,
    },
    {
      id: "4521",
      title: "Refactor auth middleware",
      story: "Auth · Sprint 42",
      elapsedSec: 1 * 3600 + 30 * 60,
      estimateMin: 240,
      started: "09:20",
    },
    {
      id: "4548",
      title: "Investigate slow query on /reports",
      story: "Performance · Sprint 42",
      elapsedSec: 22 * 60,
      estimateMin: 180,
      started: "13:25",
    },
  ],
  doneToday: [{ id: "4519", title: "Login UI cleanup", effort: "2h" }],
  upNext: [
    { id: "4533", title: "Add 2FA settings page", estimate: "3h" },
    { id: "4540", title: "Email notification cleanup", estimate: "2h" },
  ],
  stats: {
    today: "3h",
    sprintLeft: "17h",
    daysLeft: "4",
    running: "3",
    upNext: "2",
    blockers: "0",
  },
  pendingChanges: 2,
};

// ---------- tiny atoms ----------
const Mono = ({ children, className = "", style }) => (
  <span className={`mono ${className}`} style={style}>{children}</span>
);

const Dot = ({ size = 4, color = "currentColor", style }) => (
  <span aria-hidden="true" style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: color, ...style }} />
);

// Live elapsed timer (no pulse, just quiet tick)
function useTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return tick;
}

function elapsedParts(baseSec, tick) {
  const total = baseSec + tick;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return { h, m, s, total };
}

function fmtHM(baseSec, tick) {
  const { h, m } = elapsedParts(baseSec, tick);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtEstimate(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function pctOf(baseSec, tick, estimateMin) {
  return Math.min(100, Math.round(((baseSec + tick) / (estimateMin * 60)) * 100));
}

// ---------- VARIATION A — Dawn ----------
function DawnVariation() {
  const tick = useTick();
  const [focusedId, setFocusedId] = useState(
    (data.running.find((r) => r.focused) || data.running[0]).id
  );
  const focused = data.running.find((r) => r.id === focusedId) || data.running[0];
  const others = data.running.filter((r) => r.id !== focused.id);

  const [copiedKey, setCopiedKey] = useState(null);
  const copy = (key, text) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
  };
  const standupText =
    `Yesterday: Shipped login UI cleanup (#4519, 2h). Kept #4521 refactor warm.\n` +
    `Today: Finish prod hotfix on #4530, continue #4521, look into #4548 slow query.\n` +
    `Blockers: none.`;
  const standupMd =
    `**Yesterday**\n- #4519 Login UI cleanup — _2h_\n- #4521 Refactor auth middleware (in progress)\n\n` +
    `**Today**\n- Finish #4530 hotfix (1h 12m of 2h)\n- Continue #4521 refactor\n- Triage #4548 slow query\n\n` +
    `**Blockers**\n- _None_`;

  return (
    <div className="dawn">
      {/* atmosphere */}
      <div className="dawn-glow dawn-glow-1" aria-hidden="true" />
      <div className="dawn-glow dawn-glow-2" aria-hidden="true" />
      <div className="dawn-grain" aria-hidden="true" />

      {/* top bar */}
      <header className="dawn-top">
        <div className="dawn-brand">
          <span className="dawn-brand-mark" aria-hidden="true">
            <span className="dawn-brand-bar" />
            <span className="dawn-brand-bar" />
            <span className="dawn-brand-bar" />
          </span>
          <span className="dawn-brand-name">sprint<span className="dawn-brand-dot">·</span>helper</span>
        </div>
        <div className="dawn-top-meta">
          <span className="dawn-top-item">
            <span className="dim">Sprint</span>&nbsp;<Mono>42</Mono>
          </span>
          <span className="dawn-top-sep" />
          <span className="dawn-top-item">
            <span className="dim">Day</span>&nbsp;<Mono>6</Mono>&nbsp;<span className="dim">of</span>&nbsp;<Mono>10</Mono>
            <span className="dawn-sprint-rail" aria-hidden="true">
              {Array.from({ length: 10 }).map((_, i) => (
                <span key={i} className={`dawn-sprint-tick ${i < 6 ? "on" : ""} ${i === 5 ? "today" : ""}`} />
              ))}
            </span>
          </span>
          <span className="dawn-top-sep" />
          <span className="dawn-top-item dim">
            <Dot size={6} color="var(--accent)" style={{ marginRight: 8, opacity: 0.9 }} />
            Synced <Mono style={{ color: "var(--ink-1)" }}>2&nbsp;min</Mono>&nbsp;ago
          </span>
        </div>
      </header>

      {/* hero */}
      <section className="dawn-hero">
        <p className="dawn-date">{data.date}</p>
        <h1 className="dawn-greeting">
          Good morning,<br />
          <span className="dawn-greeting-name">Moran.</span>
        </h1>
        <p className="dawn-sub">
          Three threads still warm from yesterday. Settle into the hotfix —
          the others will keep until you're ready.
        </p>
        <div className="dawn-cta-row">
          <button className="dawn-cta" onClick={() => setFocusedId(focused.id)}>
            <span className="dawn-cta-label">
              <span className="dim-small">Continue</span>&nbsp;
              <Mono>#{focused.id}</Mono>&nbsp;hotfix
            </span>
            <span className="dawn-cta-arrow" aria-hidden="true">→</span>
          </button>
          <span className="dawn-cta-hint">
            <Mono>{fmtHM(focused.elapsedSec, tick)}</Mono> of <Mono>{fmtEstimate(focused.estimateMin)}</Mono>
            <span className="dim-soft">&nbsp;·&nbsp;{others.length} other{others.length === 1 ? "" : "s"} running in parallel</span>
          </span>
        </div>
      </section>

      {/* glance stats */}
      <section className="dawn-stats">
        {[
          { label: "logged today", value: data.stats.today, sub: "of 8h" },
          { label: "sprint hours left", value: data.stats.sprintLeft, sub: "of 40h" },
          { label: "days left", value: data.stats.daysLeft, sub: "in sprint" },
          { label: "running", value: data.stats.running, sub: "in parallel" },
          { label: "up next", value: data.stats.upNext, sub: "tasks" },
          { label: "blockers", value: data.stats.blockers, sub: "clear" },
        ].map((s, i) => (
          <div key={i} className="dawn-stat">
            <div className="dawn-stat-value"><Mono>{s.value}</Mono></div>
            <div className="dawn-stat-label">{s.label}</div>
            <div className="dawn-stat-sub">{s.sub}</div>
          </div>
        ))}
      </section>

      {/* RUNNING — focused + parallel */}
      <section className="dawn-runblock">
        <div className="dawn-runblock-head">
          <h3 className="dawn-section-title">Now</h3>
          <span className="dawn-section-meta">
            <Mono>1</Mono> focused · <Mono>{others.length}</Mono> in parallel
          </span>
        </div>

        {/* primary running card */}
        <article className="dawn-running">
          <div className="dawn-running-head">
            <span className="dawn-running-tag">
              <Dot size={6} color="var(--accent)" /> focused · running since <Mono>{focused.started}</Mono>
            </span>
            <span className="dawn-running-story">
              {focused.story} · <Mono className="dawn-running-id">#{focused.id}</Mono>
            </span>
          </div>
          <h2 className="dawn-running-title">{focused.title}</h2>
          <div className="dawn-running-meter">
            <div className="dawn-running-bar">
              <span style={{ width: `${pctOf(focused.elapsedSec, tick, focused.estimateMin)}%` }} />
            </div>
            <div className="dawn-running-times">
              <span>
                <Mono className="big">{fmtHM(focused.elapsedSec, tick)}</Mono>
                <span className="dim">&nbsp;elapsed</span>
              </span>
              <span className="dim">
                of&nbsp;<Mono style={{ color: "var(--ink-1)" }}>{fmtEstimate(focused.estimateMin)}</Mono>&nbsp;estimate
              </span>
            </div>
          </div>
          <div className="dawn-running-actions">
            <button className="dawn-act">
              <span className="dawn-act-glyph" aria-hidden="true">
                <span /><span />
              </span>
              Pause
            </button>
            <button className="dawn-act">
              <span className="dawn-act-glyph" aria-hidden="true">
                <span className="sq" />
              </span>
              Stop &amp; mark done
            </button>
            <button className="dawn-act dawn-act-ghost">
              Open in Azure DevOps
              <span className="dawn-act-out" aria-hidden="true">↗</span>
            </button>
          </div>
        </article>

        {/* parallel runners */}
        {others.length > 0 && (
          <div className="dawn-parallel">
            <div className="dawn-parallel-head">
              <span className="dawn-parallel-label">Also running in parallel</span>
              <span className="dawn-parallel-meta dim">
                tap <span style={{ color: "var(--ink-1)" }}>focus</span> to make one the foreground task
              </span>
            </div>
            <div className="dawn-parallel-grid">
              {others.map((r) => (
                <article key={r.id} className="dawn-mini">
                  <div className="dawn-mini-head">
                    <span className="dawn-mini-tag">
                      <Dot size={5} color="var(--accent)" style={{ opacity: 0.6 }} /> running since <Mono>{r.started}</Mono>
                    </span>
                    <Mono className="dawn-mini-id">#{r.id}</Mono>
                  </div>
                  <h4 className="dawn-mini-title">{r.title}</h4>
                  <div className="dawn-mini-story dim">{r.story}</div>
                  <div className="dawn-mini-meter">
                    <div className="dawn-mini-bar">
                      <span style={{ width: `${pctOf(r.elapsedSec, tick, r.estimateMin)}%` }} />
                    </div>
                    <div className="dawn-mini-times">
                      <Mono className="dawn-mini-elapsed">{fmtHM(r.elapsedSec, tick)}</Mono>
                      <span className="dim">&nbsp;of&nbsp;<Mono style={{ color: "var(--ink-2)" }}>{fmtEstimate(r.estimateMin)}</Mono></span>
                    </div>
                  </div>
                  <div className="dawn-mini-actions">
                    <button className="dawn-mini-act dawn-mini-act-focus" onClick={() => setFocusedId(r.id)}>
                      focus
                    </button>
                    <button className="dawn-mini-act">pause</button>
                    <button className="dawn-mini-act dawn-mini-act-ghost">
                      open <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* standup draft */}
      <section className="dawn-standup">
        <div className="dawn-section-head">
          <h3 className="dawn-section-title">Standup draft</h3>
          <span className="dawn-section-meta">auto-generated · ready in 30 min</span>
        </div>
        <div className="dawn-standup-grid">
          <div>
            <div className="dawn-standup-label">Yesterday</div>
            <p className="dawn-standup-body">
              Shipped <Mono>#4519</Mono> Login UI cleanup (<Mono>2h</Mono>). Kept
              <Mono>&nbsp;#4521</Mono> refactor warm.
            </p>
          </div>
          <div>
            <div className="dawn-standup-label">Today</div>
            <p className="dawn-standup-body">
              Finish <Mono>#4530</Mono> hotfix (<Mono>{fmtHM(focused.elapsedSec, tick)}</Mono> of <Mono>{fmtEstimate(focused.estimateMin)}</Mono>),
              continue <Mono>#4521</Mono>, dig into <Mono>#4548</Mono> slow query.
            </p>
          </div>
          <div>
            <div className="dawn-standup-label">Blockers</div>
            <p className="dawn-standup-body dim">None.</p>
          </div>
        </div>
        <div className="dawn-standup-foot">
          <button className="dawn-link" onClick={() => copy("a-text", standupText)}>
            {copiedKey === "a-text" ? "copied" : "copy text"}
          </button>
          <span className="dawn-link-sep">·</span>
          <button className="dawn-link" onClick={() => copy("a-md", standupMd)}>
            {copiedKey === "a-md" ? "copied" : "copy markdown"}
          </button>
        </div>
      </section>

      {/* today + up next */}
      <section className="dawn-lists">
        <div className="dawn-list">
          <div className="dawn-section-head">
            <h3 className="dawn-section-title">Today</h3>
            <span className="dawn-section-meta">
              {data.running.length + data.doneToday.length} items · 3h logged
            </span>
          </div>
          <ul className="dawn-items">
            {data.running.map((r) => (
              <li
                key={r.id}
                className={`dawn-item dawn-item-running ${r.id === focused.id ? "is-focused" : ""}`}
              >
                <span className="dawn-item-state">
                  {r.id === focused.id ? "focused" : "running"}
                </span>
                <Mono className="dawn-item-id">#{r.id}</Mono>
                <span className="dawn-item-title">{r.title}</span>
                <Mono className="dawn-item-effort">
                  {fmtHM(r.elapsedSec, tick)} / {fmtEstimate(r.estimateMin)}
                </Mono>
              </li>
            ))}
            {data.doneToday.map((d) => (
              <li key={d.id} className="dawn-item dawn-item-done">
                <span className="dawn-item-state">done</span>
                <Mono className="dawn-item-id">#{d.id}</Mono>
                <span className="dawn-item-title">{d.title}</span>
                <Mono className="dawn-item-effort">{d.effort}</Mono>
              </li>
            ))}
          </ul>
        </div>
        <div className="dawn-list">
          <div className="dawn-section-head">
            <h3 className="dawn-section-title">Up next</h3>
            <span className="dawn-section-meta">2 items · 5h estimated</span>
          </div>
          <ul className="dawn-items">
            {data.upNext.map((it) => (
              <li key={it.id} className="dawn-item">
                <span className="dawn-item-state dim">queued</span>
                <Mono className="dawn-item-id">#{it.id}</Mono>
                <span className="dawn-item-title">{it.title}</span>
                <Mono className="dawn-item-effort">{it.estimate}</Mono>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* sync banner */}
      <section className="dawn-sync">
        <div className="dawn-sync-text">
          <Mono className="dawn-sync-n">2</Mono>
          <span>
            <span style={{ color: "var(--ink-1)" }}>changes waiting</span> to be reported to Azure DevOps
            <span className="dawn-sync-detail"> · effort on <Mono>#4530</Mono> and <Mono>#4519</Mono></span>
          </span>
        </div>
        <button className="dawn-report">
          Report to Azure DevOps
          <span className="dawn-cta-arrow" aria-hidden="true">→</span>
        </button>
      </section>

      <footer className="dawn-foot">
        <span className="dim">local time <Mono>09:14</Mono></span>
        <span className="dim">·</span>
        <span className="dim">last sync <Mono>2 min ago</Mono></span>
        <span className="dim">·</span>
        <span className="dim">build <Mono>0.6.2</Mono></span>
      </footer>
    </div>
  );
}

// ---------- VARIATION B — Ember ----------
function EmberVariation() {
  const tick = useTick();
  const [focusedId, setFocusedId] = useState(
    (data.running.find((r) => r.focused) || data.running[0]).id
  );
  const focused = data.running.find((r) => r.id === focusedId) || data.running[0];
  const others = data.running.filter((r) => r.id !== focused.id);

  const focusedTotal = focused.elapsedSec + tick;
  const focusedH = Math.floor(focusedTotal / 3600);
  const focusedM = Math.floor((focusedTotal % 3600) / 60);
  const remainingSec = Math.max(0, focused.estimateMin * 60 - focusedTotal);
  const remainingH = Math.floor(remainingSec / 3600);
  const remainingM = Math.floor((remainingSec % 3600) / 60);
  const estimateH = Math.floor(focused.estimateMin / 60);
  const estimateM = focused.estimateMin % 60;

  const [copiedKey, setCopiedKey] = useState(null);
  const copy = (key, text) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
  };
  const standupText =
    `Yesterday: #4519 Login UI cleanup (2h). Worked on #4521 refactor too.\n` +
    `Today: finish #4530 hotfix, keep going on #4521, look into #4548 slow query.\n` +
    `Blockers: none.`;
  const standupMd =
    `**Yesterday** — #4519 Login UI cleanup (2h)\n` +
    `**Today** — finish #4530, keep going on #4521, look into #4548\n` +
    `**Blockers** — none`;

  return (
    <div className="ember">
      <div className="ember-glow ember-glow-1" aria-hidden="true" />
      <div className="ember-glow ember-glow-2" aria-hidden="true" />
      <div className="ember-grain" aria-hidden="true" />

      {/* top bar */}
      <header className="ember-top">
        <div className="ember-brand">
          <span className="ember-brand-mark" aria-hidden="true" />
          <span className="ember-brand-name">SPRINT&nbsp;HELPER</span>
          <span className="ember-brand-meta"><Mono>moran</Mono></span>
        </div>
        <div className="ember-top-right">
          <span className="ember-chip">
            <span className="dim-small">SPRINT</span>&nbsp;<Mono>42</Mono>
            <span className="ember-chip-sep" />
            <span className="dim-small">DAY</span>&nbsp;<Mono>6/10</Mono>
          </span>
          <span className="ember-sync">
            <Dot size={5} color="var(--accent)" />
            <span className="dim-small">synced</span>&nbsp;<Mono>2 min ago</Mono>
          </span>
        </div>
      </header>

      <div className="ember-main">
        {/* left: hero + sprint rail */}
        <aside className="ember-side">
          <p className="ember-date">{data.date}</p>
          <h1 className="ember-greeting">
            Good morning,
            <br />
            <span className="ember-greeting-name">Moran</span>
          </h1>
          <p className="ember-sub">
            Three tasks are still going from yesterday. Start with the hotfix —
            the others can wait.
          </p>

          <button className="ember-cta" onClick={() => setFocusedId(focused.id)}>
            <span className="ember-cta-line1"><span className="dim-small">RESUME</span></span>
            <span className="ember-cta-line2"><Mono>#{focused.id}</Mono>&nbsp;&nbsp;hotfix</span>
            <span className="ember-cta-arrow" aria-hidden="true">→</span>
          </button>
          <p className="ember-cta-foot">
            <Mono>{fmtHM(focused.elapsedSec, tick)}</Mono> of <Mono>{fmtEstimate(focused.estimateMin)}</Mono>
            <span className="dim-soft"> · {others.length} other{others.length === 1 ? "" : "s"} also going</span>
          </p>

          {/* sprint rail vertical */}
          <div className="ember-rail">
            <div className="ember-rail-head">
              <span className="dim-small">SPRINT&nbsp;42</span>
              <span className="dim-small">DAY&nbsp;<Mono style={{ color: "var(--ink-1)" }}>6</Mono>/10</span>
            </div>
            <div className="ember-rail-track">
              {Array.from({ length: 10 }).map((_, i) => {
                const isPast = i < 5;
                const isToday = i === 5;
                return (
                  <div key={i} className={`ember-rail-day ${isPast ? "past" : ""} ${isToday ? "today" : ""}`}>
                    <span className="ember-rail-tick" />
                    <span className="ember-rail-label">
                      <Mono>{["M", "T", "W", "T", "F", "M", "T", "W", "T", "F"][i]}</Mono>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="ember-rail-foot">
              <Mono className="ember-rail-big">17h</Mono>
              <span className="dim-small">remaining</span>
            </div>
          </div>
        </aside>

        {/* right: content */}
        <div className="ember-content">
          {/* glance row */}
          <section className="ember-stats">
            {[
              { label: "TODAY", value: "3h", sub: "logged" },
              { label: "SPRINT", value: "17h", sub: "left" },
              { label: "DAYS", value: "4", sub: "remaining" },
              { label: "RUNNING", value: String(data.running.length), sub: "going now" },
              { label: "NEXT", value: "2", sub: "waiting" },
              { label: "BLOCKED", value: "0", sub: "all clear" },
            ].map((s, i) => (
              <div key={i} className={`ember-stat ${s.value === "0" ? "muted" : ""}`}>
                <div className="ember-stat-label">{s.label}</div>
                <div className="ember-stat-value"><Mono>{s.value}</Mono></div>
                <div className="ember-stat-sub">{s.sub}</div>
              </div>
            ))}
          </section>

          {/* NOW + parallel runners */}
          <section className="ember-runblock">
            <div className="ember-runblock-head">
              <h3 className="ember-section-title">Now</h3>
              <span className="dim-small">
                <Mono style={{ color: "var(--ink-1)" }}>1</Mono>&nbsp;MAIN · <Mono style={{ color: "var(--ink-1)" }}>{others.length}</Mono>&nbsp;IN THE BACKGROUND
              </span>
            </div>

            {/* focused running */}
            <article className="ember-running">
              <div className="ember-running-rail" aria-hidden="true" />
              <div className="ember-running-head">
                <span className="ember-running-flag">
                  <Dot size={5} color="var(--accent)" />
                  <span className="dim-small">MAIN TASK · RUNNING</span>
                </span>
                <Mono className="ember-running-id">#{focused.id}</Mono>
                <span className="ember-running-since dim-small">
                  started <Mono style={{ color: "var(--ink-1)" }}>{focused.started}</Mono>
                </span>
              </div>
              <h2 className="ember-running-title">{focused.title}</h2>

              <div className="ember-running-numbers">
                <div className="ember-num-block">
                  <Mono className="ember-num-big">
                    {focusedH}<span>h</span>&nbsp;{String(focusedM).padStart(2, "0")}<span>m</span>
                  </Mono>
                  <span className="ember-num-cap">elapsed</span>
                </div>
                <div className="ember-num-divider" />
                <div className="ember-num-block">
                  <Mono className="ember-num-big dim">
                    {estimateH}<span>h</span>{estimateM ? ` ${String(estimateM).padStart(2, "0")}` : " 00"}<span>m</span>
                  </Mono>
                  <span className="ember-num-cap">estimate</span>
                </div>
                <div className="ember-num-divider" />
                <div className="ember-num-block">
                  <Mono className="ember-num-big dim">
                    {remainingH}<span>h</span>&nbsp;{String(remainingM).padStart(2, "0")}<span>m</span>
                  </Mono>
                  <span className="ember-num-cap">remaining</span>
                </div>
              </div>

              <div className="ember-running-bar">
                <span style={{ width: `${pctOf(focused.elapsedSec, tick, focused.estimateMin)}%` }} />
              </div>

              <div className="ember-running-actions">
                <button className="ember-act">pause</button>
                <span className="ember-act-sep">·</span>
                <button className="ember-act">stop and mark done</button>
                <span className="ember-act-sep">·</span>
                <button className="ember-act ember-act-ghost">open in Azure DevOps <span aria-hidden="true">↗</span></button>
              </div>
            </article>

            {/* parallel list */}
            {others.length > 0 && (
              <div className="ember-parallel">
                <div className="ember-parallel-head">
                  <span className="ember-parallel-label">ALSO GOING IN THE BACKGROUND</span>
                  <span className="dim-small">tap focus to switch what you're working on</span>
                </div>
                <ul className="ember-parallel-list">
                  {others.map((r) => {
                    const total = r.elapsedSec + tick;
                    const h = Math.floor(total / 3600);
                    const m = Math.floor((total % 3600) / 60);
                    return (
                      <li key={r.id} className="ember-par-row">
                        <Mono className="ember-par-id">#{r.id}</Mono>
                        <div className="ember-par-body">
                          <div className="ember-par-title">{r.title}</div>
                          <div className="ember-par-story dim-small">{r.story} · since <Mono style={{ color: "var(--ink-2)" }}>{r.started}</Mono></div>
                        </div>
                        <div className="ember-par-meter">
                          <div className="ember-par-bar">
                            <span style={{ width: `${pctOf(r.elapsedSec, tick, r.estimateMin)}%` }} />
                          </div>
                          <div className="ember-par-times">
                            <Mono className="ember-par-elapsed">{h}h&nbsp;{String(m).padStart(2, "0")}m</Mono>
                            <span className="dim">&nbsp;/&nbsp;<Mono style={{ color: "var(--ink-2)" }}>{fmtEstimate(r.estimateMin)}</Mono></span>
                          </div>
                        </div>
                        <div className="ember-par-actions">
                          <button className="ember-par-act ember-par-act-focus" onClick={() => setFocusedId(r.id)}>focus</button>
                          <button className="ember-par-act">pause</button>
                          <button className="ember-par-act ember-par-act-ghost" aria-label="open in Azure DevOps">↗</button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>

          {/* standup + lists grid */}
          <div className="ember-grid">
            <section className="ember-standup">
              <div className="ember-section-head">
                <h3 className="ember-section-title">Standup draft</h3>
                <span className="dim-small">ready 09:45</span>
              </div>
              <dl className="ember-standup-list">
                <div>
                  <dt>Yesterday</dt>
                  <dd>
                    Shipped <Mono>#4519</Mono> Login UI cleanup (<Mono>2h</Mono>). Worked on <Mono>#4521</Mono> refactor too.
                  </dd>
                </div>
                <div>
                  <dt>Today</dt>
                  <dd>
                    Finish <Mono>#{focused.id}</Mono> hotfix (<Mono>{fmtHM(focused.elapsedSec, tick)}</Mono>/<Mono>{fmtEstimate(focused.estimateMin)}</Mono>),
                    keep going on <Mono>#4521</Mono>, look into <Mono>#4548</Mono>.
                  </dd>
                </div>
                <div>
                  <dt>Blockers</dt>
                  <dd className="dim">None.</dd>
                </div>
              </dl>
              <div className="ember-standup-foot">
                <button className="ember-link" onClick={() => copy("b-text", standupText)}>
                  {copiedKey === "b-text" ? "copied" : "copy as text"}
                </button>
                <button className="ember-link" onClick={() => copy("b-md", standupMd)}>
                  {copiedKey === "b-md" ? "copied" : "copy as markdown"}
                </button>
              </div>
            </section>

            <section className="ember-tasks">
              <div className="ember-section-head">
                <h3 className="ember-section-title">Today</h3>
                <span className="dim-small">{data.running.length + data.doneToday.length} items</span>
              </div>
              <ul className="ember-items">
                {data.running.map((r) => (
                  <li key={r.id} className={`ember-item running ${r.id === focused.id ? "is-focused" : ""}`}>
                    <Mono className="ember-item-id">#{r.id}</Mono>
                    <span className="ember-item-title">{r.title}</span>
                    <span className="ember-item-state">{r.id === focused.id ? "main" : "going"}</span>
                    <Mono className="ember-item-effort">
                      {fmtHM(r.elapsedSec, tick)} / {fmtEstimate(r.estimateMin)}
                    </Mono>
                  </li>
                ))}
                {data.doneToday.map((d) => (
                  <li key={d.id} className="ember-item done">
                    <Mono className="ember-item-id">#{d.id}</Mono>
                    <span className="ember-item-title">{d.title}</span>
                    <span className="ember-item-state">done</span>
                    <Mono className="ember-item-effort">{d.effort}</Mono>
                  </li>
                ))}
              </ul>

              <div className="ember-section-head ember-section-head-tight">
                <h3 className="ember-section-title">Up next</h3>
                <span className="dim-small">2 items · 5h</span>
              </div>
              <ul className="ember-items">
                {data.upNext.map((it) => (
                  <li key={it.id} className="ember-item queued">
                    <Mono className="ember-item-id">#{it.id}</Mono>
                    <span className="ember-item-title">{it.title}</span>
                    <span className="ember-item-state dim">waiting</span>
                    <Mono className="ember-item-effort">{it.estimate}</Mono>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* sync banner */}
          <section className="ember-sync-banner">
            <div className="ember-sync-left">
              <Mono className="ember-sync-n">2</Mono>
              <div className="ember-sync-text">
                <span className="ember-sync-headline">changes to send to Azure DevOps</span>
                <span className="ember-sync-detail">time logged on <Mono>#4530</Mono> and <Mono>#4519</Mono></span>
              </div>
            </div>
            <button className="ember-report">
              <span>Send to Azure DevOps</span>
              <span aria-hidden="true" className="ember-cta-arrow">→</span>
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

window.DawnVariation = DawnVariation;
window.EmberVariation = EmberVariation;
