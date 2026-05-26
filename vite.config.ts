import { defineConfig, type Connect } from 'vite';
import react from '@vitejs/plugin-react';

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

      server.middlewares.use('/api/workitem/', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const m = url.pathname.match(/^\/(\d+)/);
          if (!m) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Work item id must be a number' }));
            return;
          }
          const id = Number(m[1]);
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
    },
  };
}
