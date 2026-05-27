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
      server.middlewares.use('/api/dashboard', async (req, res) => {
        try {
          const { buildDashboard } = await import('./server/dashboard');
          const url = new URL(req.url ?? '/', 'http://localhost');
          const sprintName = url.searchParams.get('sprint') ?? undefined;
          const payload = await buildDashboard({ sprintName });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(payload));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          const command = err instanceof Error && 'command' in err ? String((err as Error & { command?: string }).command) : undefined;
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message, command }));
        }
      });

      server.middlewares.use('/api/timer/', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const action = url.pathname.replace(/^\//, '').split('/')[0]; // start | pause | sync | done
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'POST only' }));
            return;
          }
          const body = await readJsonBody(req);
          const workItemId = Number((body as { workItemId?: number }).workItemId);
          if (!Number.isFinite(workItemId) || workItemId <= 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'workItemId must be a positive number' }));
            return;
          }
          const svc = await import('./server/timer-service');
          let result;
          switch (action) {
            case 'start':  result = svc.start(workItemId); break;
            case 'pause':  result = svc.pause(workItemId); break;
            case 'sync':   result = await svc.sync(workItemId); break;
            case 'done':   result = await svc.markDone(workItemId); break;
            default:
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `Unknown timer action: ${action}` }));
              return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({
            action: result.action,
            syncedSeconds: result.syncedSeconds,
            newCompletedHours: result.newCompletedHours,
            newState: result.newState,
            warning: result.warning,
          }));
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
              originalEstimate?: number;
              remainingWork?: number;
            };
            const { setEstimate, setRemaining, setStateBucket } = await import('./server/writes');
            const applied: Record<string, unknown> = {};
            if (body.state) {
              if (!['waiting', 'going', 'done'].includes(body.state)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'state must be waiting | going | done' }));
                return;
              }
              applied.state = await setStateBucket(id, body.state);
            }
            if (body.originalEstimate != null) {
              if (!Number.isFinite(body.originalEstimate) || body.originalEstimate < 0 || body.originalEstimate > 999) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'originalEstimate must be a finite number in [0, 999]' }));
                return;
              }
              await setEstimate(id, body.originalEstimate);
              applied.originalEstimate = body.originalEstimate;
            }
            if (body.remainingWork != null) {
              if (!Number.isFinite(body.remainingWork) || body.remainingWork < 0 || body.remainingWork > 999) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'remainingWork must be a finite number in [0, 999]' }));
                return;
              }
              await setRemaining(id, body.remainingWork);
              applied.remainingWork = body.remainingWork;
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
    },
  };
}
