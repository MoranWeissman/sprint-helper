/* global React */
const { useState } = React;

// Each palette is a tiny token bundle. Background warmth shifts subtly with the
// accent hue to keep things harmonious. Lightness and chroma on the accent stay
// within ADHD-safe bounds (chroma 0.07–0.11, lightness 0.78–0.86).
const palettes = [
  {
    id: "moonlit",
    name: "Moonlit blue",
    sub: "Current · cool, focused",
    mood: "Calm. Reads as 'night, deep work, do not disturb.'",
    tokens: {
      "--bg-0": "oklch(0.135 0.028 260)",
      "--bg-1": "oklch(0.180 0.030 258)",
      "--bg-2": "oklch(0.215 0.030 256)",
      "--bg-3": "oklch(0.275 0.030 254)",
      "--accent": "oklch(0.78 0.075 245)",
      "--accent-deep": "oklch(0.62 0.090 250)",
      "--accent-soft": "oklch(0.78 0.075 245 / 0.18)",
      "--accent-hair": "oklch(0.78 0.075 245 / 0.30)",
      "--ink-0": "oklch(0.95 0.014 230)",
      "--ink-1": "oklch(0.87 0.016 232)",
      "--ink-2": "oklch(0.67 0.022 238)",
      "--ink-3": "oklch(0.50 0.025 244)",
      "--ink-4": "oklch(0.38 0.025 248)",
      "--surface-card": "linear-gradient(160deg, oklch(0.205 0.032 256), oklch(0.155 0.028 258))",
      "--surface-row": "oklch(0.20 0.030 256 / 0.6)",
      "--surface-input": "oklch(0.155 0.028 258)",
    },
  },
  {
    id: "honey",
    name: "Honey amber",
    sub: "Warm, glowy",
    mood: "Lamp-lit room at dusk. Inviting without being loud.",
    tokens: {
      "--bg-0": "oklch(0.138 0.018 60)",
      "--bg-1": "oklch(0.183 0.022 58)",
      "--bg-2": "oklch(0.218 0.024 56)",
      "--bg-3": "oklch(0.278 0.024 54)",
      "--accent": "oklch(0.83 0.105 78)",
      "--accent-deep": "oklch(0.66 0.115 70)",
      "--accent-soft": "oklch(0.83 0.105 78 / 0.18)",
      "--accent-hair": "oklch(0.83 0.105 78 / 0.30)",
      "--ink-0": "oklch(0.95 0.012 75)",
      "--ink-1": "oklch(0.87 0.014 72)",
      "--ink-2": "oklch(0.67 0.018 70)",
      "--ink-3": "oklch(0.50 0.020 68)",
      "--ink-4": "oklch(0.38 0.020 66)",
      "--surface-card": "linear-gradient(160deg, oklch(0.208 0.024 58), oklch(0.158 0.020 58))",
      "--surface-row": "oklch(0.205 0.024 58 / 0.6)",
      "--surface-input": "oklch(0.158 0.020 58)",
    },
  },
  {
    id: "mint",
    name: "Mint sage",
    sub: "Fresh, quiet",
    mood: "Morning, but still indoor. Greens read as growth not alarm.",
    tokens: {
      "--bg-0": "oklch(0.135 0.020 180)",
      "--bg-1": "oklch(0.180 0.022 180)",
      "--bg-2": "oklch(0.215 0.024 180)",
      "--bg-3": "oklch(0.275 0.024 180)",
      "--accent": "oklch(0.85 0.085 165)",
      "--accent-deep": "oklch(0.68 0.095 165)",
      "--accent-soft": "oklch(0.85 0.085 165 / 0.18)",
      "--accent-hair": "oklch(0.85 0.085 165 / 0.30)",
      "--ink-0": "oklch(0.95 0.014 180)",
      "--ink-1": "oklch(0.87 0.016 180)",
      "--ink-2": "oklch(0.67 0.020 180)",
      "--ink-3": "oklch(0.50 0.022 180)",
      "--ink-4": "oklch(0.38 0.022 180)",
      "--surface-card": "linear-gradient(160deg, oklch(0.205 0.024 180), oklch(0.158 0.022 180))",
      "--surface-row": "oklch(0.20 0.024 180 / 0.6)",
      "--surface-input": "oklch(0.158 0.022 180)",
    },
  },
  {
    id: "peach",
    name: "Peach blush",
    sub: "Friendly, soft",
    mood: "Sunrise edge. Reads as 'fresh start' not 'urgent.'",
    tokens: {
      "--bg-0": "oklch(0.140 0.022 30)",
      "--bg-1": "oklch(0.185 0.025 28)",
      "--bg-2": "oklch(0.220 0.027 26)",
      "--bg-3": "oklch(0.280 0.028 24)",
      "--accent": "oklch(0.82 0.095 42)",
      "--accent-deep": "oklch(0.66 0.105 38)",
      "--accent-soft": "oklch(0.82 0.095 42 / 0.18)",
      "--accent-hair": "oklch(0.82 0.095 42 / 0.30)",
      "--ink-0": "oklch(0.95 0.012 40)",
      "--ink-1": "oklch(0.87 0.014 38)",
      "--ink-2": "oklch(0.67 0.018 36)",
      "--ink-3": "oklch(0.50 0.020 34)",
      "--ink-4": "oklch(0.38 0.020 32)",
      "--surface-card": "linear-gradient(160deg, oklch(0.210 0.027 30), oklch(0.160 0.024 28))",
      "--surface-row": "oklch(0.205 0.027 30 / 0.6)",
      "--surface-input": "oklch(0.160 0.024 28)",
    },
  },
  {
    id: "lilac",
    name: "Lilac dusk",
    sub: "Playful but quiet",
    mood: "Twilight. Slightly whimsical without being childlike.",
    tokens: {
      "--bg-0": "oklch(0.138 0.024 295)",
      "--bg-1": "oklch(0.183 0.026 295)",
      "--bg-2": "oklch(0.218 0.028 295)",
      "--bg-3": "oklch(0.278 0.030 295)",
      "--accent": "oklch(0.80 0.085 305)",
      "--accent-deep": "oklch(0.64 0.100 305)",
      "--accent-soft": "oklch(0.80 0.085 305 / 0.18)",
      "--accent-hair": "oklch(0.80 0.085 305 / 0.30)",
      "--ink-0": "oklch(0.95 0.014 290)",
      "--ink-1": "oklch(0.87 0.016 292)",
      "--ink-2": "oklch(0.67 0.020 294)",
      "--ink-3": "oklch(0.50 0.024 296)",
      "--ink-4": "oklch(0.38 0.024 298)",
      "--surface-card": "linear-gradient(160deg, oklch(0.208 0.028 295), oklch(0.158 0.024 295))",
      "--surface-row": "oklch(0.205 0.028 295 / 0.6)",
      "--surface-input": "oklch(0.158 0.024 295)",
    },
  },
  {
    id: "citron",
    name: "Citron",
    sub: "Zingy, alive",
    mood: "The loudest option that's still safe. Reads 'energetic.'",
    tokens: {
      "--bg-0": "oklch(0.135 0.020 130)",
      "--bg-1": "oklch(0.180 0.022 130)",
      "--bg-2": "oklch(0.215 0.024 130)",
      "--bg-3": "oklch(0.275 0.024 130)",
      "--accent": "oklch(0.88 0.115 112)",
      "--accent-deep": "oklch(0.72 0.125 112)",
      "--accent-soft": "oklch(0.88 0.115 112 / 0.18)",
      "--accent-hair": "oklch(0.88 0.115 112 / 0.30)",
      "--ink-0": "oklch(0.95 0.014 130)",
      "--ink-1": "oklch(0.87 0.016 130)",
      "--ink-2": "oklch(0.67 0.020 130)",
      "--ink-3": "oklch(0.50 0.022 130)",
      "--ink-4": "oklch(0.38 0.022 130)",
      "--surface-card": "linear-gradient(160deg, oklch(0.205 0.024 130), oklch(0.158 0.022 130))",
      "--surface-row": "oklch(0.20 0.024 130 / 0.6)",
      "--surface-input": "oklch(0.158 0.022 130)",
    },
  },
  /* ---------- grayscale-with-tint family ---------- */
  /* "dark white and gray" — accent is a tinted near-white, not a color.
     The focal point still pops because lightness contrast does the work. */
  {
    id: "graphite",
    name: "Warm graphite",
    sub: "Tinted gray · cream accent",
    mood: "Newspaper-at-night. Warm browns under a near-white focal.",
    tokens: {
      "--bg-0": "oklch(0.142 0.005 60)",
      "--bg-1": "oklch(0.188 0.006 58)",
      "--bg-2": "oklch(0.222 0.008 56)",
      "--bg-3": "oklch(0.280 0.010 54)",
      "--accent": "oklch(0.93 0.022 78)",
      "--accent-deep": "oklch(0.76 0.030 70)",
      "--accent-soft": "oklch(0.93 0.022 78 / 0.16)",
      "--accent-hair": "oklch(0.93 0.022 78 / 0.30)",
      "--ink-0": "oklch(0.96 0.010 70)",
      "--ink-1": "oklch(0.88 0.012 68)",
      "--ink-2": "oklch(0.67 0.014 66)",
      "--ink-3": "oklch(0.50 0.016 64)",
      "--ink-4": "oklch(0.38 0.016 62)",
      "--surface-card": "linear-gradient(160deg, oklch(0.212 0.008 58), oklch(0.162 0.006 58))",
      "--surface-row": "oklch(0.205 0.008 58 / 0.6)",
      "--surface-input": "oklch(0.158 0.006 58)",
    },
  },
  {
    id: "slate",
    name: "Cool slate",
    sub: "Tinted gray · ice accent",
    mood: "Crisp, photographic. Steel-blue grays under a clean white.",
    tokens: {
      "--bg-0": "oklch(0.140 0.006 230)",
      "--bg-1": "oklch(0.184 0.008 228)",
      "--bg-2": "oklch(0.218 0.010 226)",
      "--bg-3": "oklch(0.276 0.012 224)",
      "--accent": "oklch(0.94 0.014 220)",
      "--accent-deep": "oklch(0.76 0.024 222)",
      "--accent-soft": "oklch(0.94 0.014 220 / 0.16)",
      "--accent-hair": "oklch(0.94 0.014 220 / 0.30)",
      "--ink-0": "oklch(0.96 0.010 222)",
      "--ink-1": "oklch(0.88 0.012 224)",
      "--ink-2": "oklch(0.67 0.014 226)",
      "--ink-3": "oklch(0.50 0.016 228)",
      "--ink-4": "oklch(0.38 0.016 230)",
      "--surface-card": "linear-gradient(160deg, oklch(0.208 0.010 226), oklch(0.160 0.008 226))",
      "--surface-row": "oklch(0.205 0.010 226 / 0.6)",
      "--surface-input": "oklch(0.158 0.008 226)",
    },
  },
  {
    id: "olive",
    name: "Olive ash",
    sub: "Tinted gray · bone accent",
    mood: "Editorial. Khaki-green undertone, very dry.",
    tokens: {
      "--bg-0": "oklch(0.140 0.008 130)",
      "--bg-1": "oklch(0.184 0.010 128)",
      "--bg-2": "oklch(0.218 0.012 126)",
      "--bg-3": "oklch(0.276 0.014 124)",
      "--accent": "oklch(0.93 0.020 100)",
      "--accent-deep": "oklch(0.76 0.030 105)",
      "--accent-soft": "oklch(0.93 0.020 100 / 0.16)",
      "--accent-hair": "oklch(0.93 0.020 100 / 0.30)",
      "--ink-0": "oklch(0.96 0.010 110)",
      "--ink-1": "oklch(0.88 0.012 110)",
      "--ink-2": "oklch(0.67 0.014 110)",
      "--ink-3": "oklch(0.50 0.016 110)",
      "--ink-4": "oklch(0.38 0.016 110)",
      "--surface-card": "linear-gradient(160deg, oklch(0.208 0.012 126), oklch(0.160 0.010 126))",
      "--surface-row": "oklch(0.205 0.012 126 / 0.6)",
      "--surface-input": "oklch(0.158 0.010 126)",
    },
  },
  {
    id: "plum",
    name: "Plum smoke",
    sub: "Tinted gray · blush accent",
    mood: "Quiet warm-cool tension. Faintly purple shadows, peach-tinted focal.",
    tokens: {
      "--bg-0": "oklch(0.140 0.008 310)",
      "--bg-1": "oklch(0.184 0.010 308)",
      "--bg-2": "oklch(0.218 0.012 306)",
      "--bg-3": "oklch(0.276 0.014 304)",
      "--accent": "oklch(0.93 0.020 30)",
      "--accent-deep": "oklch(0.76 0.034 28)",
      "--accent-soft": "oklch(0.93 0.020 30 / 0.16)",
      "--accent-hair": "oklch(0.93 0.020 30 / 0.30)",
      "--ink-0": "oklch(0.96 0.012 320)",
      "--ink-1": "oklch(0.88 0.014 318)",
      "--ink-2": "oklch(0.67 0.016 316)",
      "--ink-3": "oklch(0.50 0.018 314)",
      "--ink-4": "oklch(0.38 0.018 312)",
      "--surface-card": "linear-gradient(160deg, oklch(0.208 0.012 308), oklch(0.160 0.010 308))",
      "--surface-row": "oklch(0.205 0.012 308 / 0.6)",
      "--surface-input": "oklch(0.158 0.010 308)",
    },
  },
  {
    id: "petrol",
    name: "Petrol steel",
    sub: "Tinted gray · frost accent",
    mood: "Industrial calm. Teal-leaning grays, very clean focal.",
    tokens: {
      "--bg-0": "oklch(0.138 0.008 200)",
      "--bg-1": "oklch(0.182 0.010 198)",
      "--bg-2": "oklch(0.216 0.012 196)",
      "--bg-3": "oklch(0.274 0.014 194)",
      "--accent": "oklch(0.94 0.018 200)",
      "--accent-deep": "oklch(0.76 0.030 200)",
      "--accent-soft": "oklch(0.94 0.018 200 / 0.16)",
      "--accent-hair": "oklch(0.94 0.018 200 / 0.30)",
      "--ink-0": "oklch(0.96 0.010 200)",
      "--ink-1": "oklch(0.88 0.012 200)",
      "--ink-2": "oklch(0.67 0.014 200)",
      "--ink-3": "oklch(0.50 0.016 200)",
      "--ink-4": "oklch(0.38 0.016 200)",
      "--surface-card": "linear-gradient(160deg, oklch(0.206 0.012 196), oklch(0.158 0.010 196))",
      "--surface-row": "oklch(0.205 0.012 196 / 0.6)",
      "--surface-input": "oklch(0.158 0.010 196)",
    },
  },
];

// Sample data — single task expanded showing every editor primitive.
const sampleTask = {
  id: "426268",
  title: "Wire ADO PATCH effort",
  elapsed: "1h 23m",
  estimate: 4,
  remaining: 2.5,
  state: "going",
};
const collapsedTasks = [
  { id: "426269", title: "Test against staging org", elapsed: "0h", estimate: 2, state: "waiting" },
  { id: "426270", title: "Update CODEOWNERS docs", elapsed: "0h 52m", estimate: 1.5, state: "waiting" },
];

const Mono = ({ children, style }) => (
  <span className="mono" style={style}>{children}</span>
);

function StatePicker({ value, onChange }) {
  const pills = ["waiting", "going", "done"];
  return (
    <div className="po-statepick">
      {pills.map((p) => (
        <button
          key={p}
          className={`po-statepick-seg ${value === p ? "is-active" : ""}`}
          onClick={() => onChange(p)}
        >{p}</button>
      ))}
    </div>
  );
}

function Stepper({ value, onChange, step = 0.5 }) {
  return (
    <div className="po-stepper">
      <button className="po-stepper-btn" onClick={() => onChange(Math.max(0, value - step))}>−</button>
      <span className="po-stepper-val mono">{value}h</span>
      <button className="po-stepper-btn" onClick={() => onChange(value + step)}>+</button>
    </div>
  );
}

function PaletteCard({ palette }) {
  const [taskState, setTaskState] = useState(sampleTask.state);
  const [estimate, setEstimate] = useState(sampleTask.estimate);
  const [remaining, setRemaining] = useState(sampleTask.remaining);

  return (
    <div className="po-frame" style={palette.tokens}>
      <div className="po-head">
        <span className="po-swatch" />
        <div className="po-headtext">
          <div className="po-name">{palette.name}</div>
          <div className="po-sub">{palette.sub}</div>
        </div>
      </div>
      <p className="po-mood">{palette.mood}</p>

      <div className="po-card">
        <div className="po-card-rail" aria-hidden="true" />
        <div className="po-card-head">
          <span className="po-flag">
            <span className="po-dot" />
            <span className="po-cap">ACTIVE STORY</span>
          </span>
          <Mono style={{ color: "var(--ink-2)", fontSize: 12 }}>#426267</Mono>
        </div>
        <h3 className="po-title">CODEOWNERS model — automate routing</h3>

        {/* expanded task */}
        <div className="po-task is-open">
          <div className="po-task-row">
            <Mono style={{ color: "var(--ink-2)", fontSize: 12 }}>#{sampleTask.id}</Mono>
            <span className="po-task-title">{sampleTask.title}</span>
            <Mono style={{ color: "var(--ink-2)", fontSize: 12 }}>
              {sampleTask.elapsed} <span style={{ color: "var(--ink-4)" }}>/ {sampleTask.estimate}h</span>
            </Mono>
            <span className="po-task-state">GOING</span>
            <span className="po-chev is-open">›</span>
          </div>
          <div className="po-expand">
            <div className="po-expand-strip">
              <div className="po-group">
                <span className="po-cap">STATE</span>
                <StatePicker value={taskState} onChange={setTaskState} />
              </div>
              <div className="po-group">
                <span className="po-cap">ESTIMATE</span>
                <Stepper value={estimate} onChange={setEstimate} />
              </div>
              <div className="po-group">
                <span className="po-cap">REMAINING</span>
                <Stepper value={remaining} onChange={setRemaining} />
              </div>
            </div>
          </div>
        </div>

        {/* collapsed tasks */}
        {collapsedTasks.map((t) => (
          <div key={t.id} className="po-task">
            <div className="po-task-row">
              <Mono style={{ color: "var(--ink-2)", fontSize: 12 }}>#{t.id}</Mono>
              <span className="po-task-title" style={{ color: "var(--ink-1)" }}>{t.title}</span>
              <Mono style={{ color: "var(--ink-2)", fontSize: 12 }}>
                {t.elapsed} <span style={{ color: "var(--ink-4)" }}>/ {t.estimate}h</span>
              </Mono>
              <span className="po-task-state" style={{ color: "var(--ink-3)" }}>WAITING</span>
              <span className="po-chev">›</span>
            </div>
          </div>
        ))}
      </div>

      <div className="po-tokens">
        <code>--accent</code>
        <span className="po-tokencode">{palette.tokens["--accent"]}</span>
      </div>
    </div>
  );
}

function PaletteOptions() {
  return (
    <div className="po-grid">
      {palettes.map((p) => <PaletteCard key={p.id} palette={p} />)}
    </div>
  );
}

window.PaletteOptions = PaletteOptions;
