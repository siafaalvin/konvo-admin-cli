/**
 * dev-servers — Start, stop, restart, or check status of all local PWA dev sites.
 *
 * Port assignments:
 *   5174 — houvox-pwa (Konvo main app) [staging mode]
 *   5175 — crowdfund-platform
 *   5176 — definish-pwa
 *   5177 — two-100-pwa
 */

import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';
import { execSync, spawn } from 'child_process';

const PROJECTS_DIR = '/Applications/Projects';

interface AppConfig {
  port: number;
  mode?: string;  // vite --mode flag
  devCmd?: string; // override dev command (default: npx vite dev)
}

const APPS: Record<string, AppConfig> = {
  'houvox-pwa':         { port: 5174, mode: 'staging' },
  'crowdfund-platform': { port: 5175 },
  'definish-pwa':       { port: 5176 },
  'two-100-pwa':        { port: 5177 },
};

function isPortInUse(port: number): boolean {
  try {
    const out = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function killPort(port: number): void {
  try {
    execSync(`lsof -ti :${port} | xargs kill 2>/dev/null`, { encoding: 'utf-8' });
  } catch {
    // Port wasn't in use
  }
}

function startApp(name: string, config: AppConfig): boolean {
  const dir = `${PROJECTS_DIR}/${name}`;

  // Check if directory exists
  try {
    execSync(`test -d "${dir}"`, { encoding: 'utf-8' });
  } catch {
    return false;
  }

  // Install deps if needed
  try {
    execSync(`test -d "${dir}/node_modules"`, { encoding: 'utf-8' });
  } catch {
    execSync(`cd "${dir}" && bun install --silent`, { encoding: 'utf-8' });
  }

  // Build command
  const args = ['vite', 'dev', '--port', String(config.port)];
  if (config.mode) args.push('--mode', config.mode);

  // Start in background (detached)
  const child = spawn('npx', args, {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return true;
}

function getStatus(): Array<{ name: string; port: number; running: boolean; mode?: string }> {
  return Object.entries(APPS).map(([name, config]) => ({
    name,
    port: config.port,
    running: isPortInUse(config.port),
    mode: config.mode,
  }));
}

const devServers: Runbook = {
  id: 'dev-servers',
  title: 'Dev Servers',
  description: 'Start, stop, restart, or check status of local PWA dev sites.',
  risk: 'low',
  requires: [],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const action = await prompt.select({
      message: 'What do you want to do?',
      options: [
        { value: 'status', label: 'Status — check which servers are running' },
        { value: 'start', label: 'Start — start all dev servers' },
        { value: 'stop', label: 'Stop — stop all dev servers' },
        { value: 'restart', label: 'Restart — stop then start all' },
        { value: 'start-one', label: 'Start one — pick a specific app' },
      ],
    });

    if (prompt.isCancel(action)) {
      return { success: false, summary: 'Cancelled.' };
    }

    if (action === 'status') {
      const statuses = getStatus();
      const lines = statuses.map(s =>
        `  ${s.running ? '●' : '○'} ${s.name} — :${s.port} ${s.running ? '(running)' : '(stopped)'}${s.mode ? ` [${s.mode}]` : ''}`
      );
      prompt.note(lines.join('\n'), 'Dev Server Status');
      return { success: true, summary: `${statuses.filter(s => s.running).length}/${statuses.length} servers running.` };
    }

    if (action === 'stop') {
      for (const [name, config] of Object.entries(APPS)) {
        if (isPortInUse(config.port)) {
          killPort(config.port);
          prompt.log.success(`${name} stopped (port ${config.port})`);
        } else {
          prompt.log.warn(`${name} not running (port ${config.port})`);
        }
      }
      return { success: true, summary: 'All dev servers stopped.' };
    }

    if (action === 'start' || action === 'restart') {
      // Stop first if restart
      if (action === 'restart') {
        for (const config of Object.values(APPS)) {
          killPort(config.port);
        }
        // Wait for ports to free
        await new Promise(r => setTimeout(r, 2000));
      }

      const results: string[] = [];
      for (const [name, config] of Object.entries(APPS)) {
        if (isPortInUse(config.port)) {
          prompt.log.warn(`${name} already running on :${config.port}`);
          results.push(`${name}: already running`);
          continue;
        }
        const started = startApp(name, config);
        if (started) {
          prompt.log.success(`${name} starting on :${config.port}${config.mode ? ` [${config.mode}]` : ''}`);
          results.push(`${name}: started`);
        } else {
          prompt.log.error(`${name} directory not found`);
          results.push(`${name}: not found`);
        }
      }

      // Wait for servers to boot
      await new Promise(r => setTimeout(r, 4000));

      const statuses = getStatus();
      const running = statuses.filter(s => s.running).length;
      prompt.note(
        statuses.map(s => `  ${s.running ? '●' : '○'} http://localhost:${s.port} — ${s.name}`).join('\n'),
        `${running}/${statuses.length} servers ready`
      );
      return { success: true, summary: `${running}/${statuses.length} dev servers running.` };
    }

    if (action === 'start-one') {
      const appChoice = await prompt.select({
        message: 'Which app?',
        options: Object.entries(APPS).map(([name, config]) => ({
          value: name,
          label: `${name} (:${config.port})${isPortInUse(config.port) ? ' [running]' : ''}`,
        })),
      });

      if (prompt.isCancel(appChoice)) {
        return { success: false, summary: 'Cancelled.' };
      }

      const config = APPS[appChoice as string];
      if (isPortInUse(config.port)) {
        killPort(config.port);
        await new Promise(r => setTimeout(r, 1000));
      }
      startApp(appChoice as string, config);
      await new Promise(r => setTimeout(r, 4000));

      if (isPortInUse(config.port)) {
        prompt.log.success(`${appChoice} ready at http://localhost:${config.port}`);
        return { success: true, summary: `${appChoice} started on :${config.port}.` };
      } else {
        prompt.log.error(`${appChoice} failed to start`);
        return { success: false, summary: `${appChoice} failed to start.` };
      }
    }

    return { success: false, summary: 'Unknown action.' };
  },
};

export default devServers;
