import { defineConfig, type Connect } from 'vite';
import type { IncomingMessage } from 'node:http';
import react from '@vitejs/plugin-react';

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export default defineConfig({
  plugins: [react(), adoApiPlugin()],
  server: {
    port: 7777,
    strictPort: false,
    open: false,
  },
});

/**
 * Vite middleware that exposes the dashboard data API.
 * Imported lazily so production builds don't include server-only code.
 */
function adoApiPlugin() {
  return {
    name: 'sprint-helper-api',
    configureServer(server: { middlewares: Connect.Server }) {
      // Pre-warm at startup: transform the backend module graph + warm the ADO
      // iteration cache + az token + the dashboard cache in the background, so
      // the FIRST page load after `npm run dev` hits the fast (warm) path.
      // After the warm, kick off the auto-refresh timer so the Outlook-derived
      // 'available' tile catches meeting changes even when the dashboard is
      // idle in a browser tab.
      void (async () => {
        try {
          const { buildDashboardCached, startAutoRefresh } = await import('./server/dashboard-cache');
          await buildDashboardCached();
          startAutoRefresh();
        } catch {
          // Ignore — a real request will surface any error (e.g. az login needed).
        }
      })();

      server.middlewares.use('/api/dashboard', async (req, res) => {
        try {
          const { buildDashboardCached } = await import('./server/dashboard-cache');
          const url = new URL(req.url ?? '/', 'http://localhost');
          const sprintName = url.searchParams.get('sprint') ?? undefined;
          const result = await buildDashboardCached({ sprintName });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Cache', result.cache);
          res.setHeader('X-Cache-Age-Ms', String(result.cacheAgeMs));
          res.end(JSON.stringify(result.payload));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          const command = err instanceof Error && 'command' in err ? String((err as Error & { command?: string }).command) : undefined;
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message, command }));
        }
      });

      server.middlewares.use('/api/workitem/', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const m = url.pathname.match(/^\/(\d+)(\/edit)?/);
          if (!m) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Work item id must be a number' }));
            return;
          }
          const id = Number(m[1]);
          const isEdit = !!m[2];

          if (isEdit) {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'POST only' }));
              return;
            }
            const body = (await readJsonBody(req)) as {
              state?: 'waiting' | 'going' | 'done';
              completedHours?: number;
              originalEstimate?: number;
              remainingWork?: number;
              iterationPath?: string;
            };
            // Original Estimate is set once at creation and never edited after
            // (same lock as the workitem_edit MCP tool). Refuse changing it here
            // too, so both doors keep one promise.
            if (body.originalEstimate != null) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Original Estimate is set once when a task is created and cannot be edited afterwards.' }));
              return;
            }
            const { setCompletedWork, setIterationPath, setRemaining, setStateBucket } = await import('./server/writes');
            const applied: Record<string, unknown> = {};
            if (body.state) {
              if (!['waiting', 'going', 'done'].includes(body.state)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'state must be waiting | going | done' }));
                return;
              }
              if (body.state === 'done') {
                // Closing must capture the real hours, exactly like
                // session_end({done:true, completedHoursAfter}). A bare "mark
                // done" with no hours is refused — the dashboard door keeping
                // the same lock as the AI door.
                const h = body.completedHours;
                if (h == null || !Number.isFinite(h) || h <= 0 || h > 999) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'Closing a task needs completedHours — the hours it actually took — as a number greater than 0 (max 999).' }));
                  return;
                }
                await setCompletedWork(id, h);
                await setRemaining(id, 0);
                applied.state = await setStateBucket(id, 'done');
                applied.completedHours = h;
                applied.remainingWork = 0;
              } else {
                applied.state = await setStateBucket(id, body.state);
              }
            }
            if (body.remainingWork != null && body.state !== 'done') {
              if (!Number.isFinite(body.remainingWork) || body.remainingWork < 0 || body.remainingWork > 999) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'remainingWork must be a finite number in [0, 999]' }));
                return;
              }
              await setRemaining(id, body.remainingWork);
              applied.remainingWork = body.remainingWork;
            }
            if (body.iterationPath != null) {
              if (typeof body.iterationPath !== 'string' || body.iterationPath.length === 0) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'iterationPath must be a non-empty string' }));
                return;
              }
              await setIterationPath(id, body.iterationPath);
              applied.iterationPath = body.iterationPath;
            }
            if (Object.keys(applied).length > 0) {
              const { invalidateDashboardCache } = await import('./server/dashboard-cache');
              invalidateDashboardCache();
            }
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ applied }));
            return;
          }

          const { getWorkItem, getWorkItemComments } = await import('./server/ado');
          const [item, comments] = await Promise.all([getWorkItem(id), getWorkItemComments(id).catch(() => [])]);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ item, comments }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          const command = err instanceof Error && 'command' in err ? String((err as Error & { command?: string }).command) : undefined;
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message, command }));
        }
      });

      server.middlewares.use('/api/schedule', async (req, res) => {
        try {
          const { getCeremonySchedule, setCeremonySchedule } = await import('./server/ceremony');
          const method = req.method ?? 'GET';
          if (method === 'GET') {
            const schedule = getCeremonySchedule();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(schedule));
            return;
          }
          if (method === 'PUT' || method === 'POST') {
            const body = await readJsonBody(req);
            try {
              setCeremonySchedule(body as never);
            } catch (validationErr) {
              const msg = validationErr instanceof Error ? validationErr.message : 'invalid schedule';
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: msg }));
              return;
            }
            const saved = getCeremonySchedule();
            const { invalidateDashboardCache } = await import('./server/dashboard-cache');
            invalidateDashboardCache();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(saved));
            return;
          }
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'GET, PUT, or POST only' }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message }));
        }
      });

      server.middlewares.use('/api/helper-note/', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const m = url.pathname.match(/^\/(\d+)\/dismiss\/?$/);
          if (!m) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Expected /api/helper-note/<id>/dismiss' }));
            return;
          }
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'POST only' }));
            return;
          }
          const { dismissNote } = await import('./server/helper-notes');
          const dismissed = dismissNote(Number(m[1]));
          if (dismissed) {
            const { invalidateDashboardCache } = await import('./server/dashboard-cache');
            invalidateDashboardCache();
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ dismissed }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message }));
        }
      });

      server.middlewares.use('/api/planning/gaps', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'GET only' }));
            return;
          }
          const { findGaps } = await import('./server/planning');
          const result = await findGaps();
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message }));
        }
      });

      server.middlewares.use('/api/planning/cockpit', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'GET only' }));
            return;
          }
          const { buildCockpitPayload } = await import('./server/planning-cockpit');
          const result = await buildCockpitPayload();
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message }));
        }
      });
    },
  };
}
