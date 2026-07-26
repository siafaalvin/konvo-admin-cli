/**
 * Runbook — Check system health.
 *
 * Read-only. Pings all Konvo services and shows a quick status
 * dashboard: HTTP endpoints, Docker containers, and database
 * connectivity.
 *
 * No user input needed beyond launching it. Great first thing to
 * check when something seems off.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped, exec } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface ServiceCheck {
  service:      string;
  status:       'up' | 'down' | 'slow';
  responseTime: number;   // ms
  detail:       string;
}

const HTTP_SERVICES = [
  { label: 'Konvo PWA',           url: 'https://app.thekonvo.com/' },
  { label: 'Verification Worker', url: 'https://worker.thekonvo.com/healthz' },
  { label: 'Crowdfund Platform',  url: 'https://crowdfund.thekonvo.com/' },
  { label: 'Centrifugo Realtime', url: 'https://rt.thekonvo.com/health' },
] as const;

async function checkHttp(service: typeof HTTP_SERVICES[number]): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(service.url, { signal: ac.signal, redirect: 'manual' });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    const ok = res.status >= 200 && res.status < 400;
    return {
      service:      service.label,
      status:       ok ? (elapsed > 3000 ? 'slow' : 'up') : 'down',
      responseTime: elapsed,
      detail:       `HTTP ${res.status}`
    };
  } catch (err) {
    return {
      service:      service.label,
      status:       'down',
      responseTime: Date.now() - start,
      detail:       err instanceof Error ? err.message.slice(0, 80) : 'Unknown error'
    };
  }
}

const runbook: Runbook = {
  id:          'check-system-health',
  title:       'Check system health',
  description: 'Quick health check of all Konvo services (PWA, worker, database, crowdfund platform).',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;
    const results: ServiceCheck[] = [];

    const sp = prompt.spinner();
    sp.start('Checking all services… (this may take a few seconds)');

    // 1. HTTP checks (run in parallel)
    const httpResults = await Promise.all(HTTP_SERVICES.map(checkHttp));
    results.push(...httpResults);

    // 2. Docker containers via SSH
    try {
      const dockerRes = await exec(ctx.config, 'docker ps --format "{{.Names}}|{{.Status}}" 2>/dev/null | head -20');
      const start = Date.now();
      const elapsed = Date.now() - start;
      if (dockerRes.exitCode === 0) {
        const lines = dockerRes.stdout.trim().split('\n').filter(Boolean);
        const unhealthy = lines.filter(l => l.toLowerCase().includes('unhealthy'));
        results.push({
          service:      'Docker Containers',
          status:       unhealthy.length > 0 ? 'down' : 'up',
          responseTime: elapsed,
          detail:       unhealthy.length > 0
            ? `${unhealthy.length} unhealthy: ${unhealthy.map(l => l.split('|')[0]).join(', ')}`
            : `${lines.length} containers running`
        });
      } else {
        results.push({
          service: 'Docker Containers',
          status: 'down',
          responseTime: elapsed,
          detail: `SSH/docker failed: ${dockerRes.stderr.trim().slice(0, 80)}`
        });
      }
    } catch (err) {
      results.push({
        service: 'Docker Containers',
        status: 'down',
        responseTime: 0,
        detail: err instanceof Error ? err.message.slice(0, 80) : 'SSH failed'
      });
    }

    // 3. Database connectivity
    try {
      const start = Date.now();
      const dbRes = await psqlPiped(ctx.config, 'SELECT 1 AS alive;\n');
      const elapsed = Date.now() - start;
      results.push({
        service:      'Database (PostgreSQL)',
        status:       dbRes.exitCode === 0 ? (elapsed > 5000 ? 'slow' : 'up') : 'down',
        responseTime: elapsed,
        detail:       dbRes.exitCode === 0 ? 'Responding' : `Exit ${dbRes.exitCode}`
      });
    } catch (err) {
      results.push({
        service: 'Database (PostgreSQL)',
        status: 'down',
        responseTime: 0,
        detail: err instanceof Error ? err.message.slice(0, 80) : 'Connection failed'
      });
    }

    sp.stop('Health check complete.');

    // Format results as a table
    const statusIcon = (s: ServiceCheck['status']): string => {
      switch (s) {
        case 'up':   return c.green('✓ UP');
        case 'slow': return c.yellow('⚠ SLOW');
        case 'down': return c.red('✗ DOWN');
      }
    };

    const tableLines = results.map(r =>
      `  ${statusIcon(r.status).padEnd(18)} ${r.service.padEnd(24)} ${c.dim(`${r.responseTime}ms`).padEnd(12)} ${c.dim(r.detail)}`
    );

    prompt.note(
      [
        `Status           Service                  Time        Detail`,
        `─────────────────────────────────────────────────────────────────────────`,
        ...tableLines
      ].join('\n'),
      'System Health'
    );

    // Show suggestions if anything is down
    const failures = results.filter(r => r.status === 'down');
    if (failures.length > 0) {
      const suggestions = failures.map(f => {
        if (f.service.includes('Worker')) return `• Worker down — try the "Restart service" runbook or check worker logs`;
        if (f.service.includes('Docker')) return `• Docker issue — SSH into the server and run: docker ps`;
        if (f.service.includes('Database')) return `• Database not responding — check if the Supabase container is running`;
        if (f.service.includes('PWA')) return `• PWA not loading — check Cloudflare Pages deployment status`;
        if (f.service.includes('Crowdfund')) return `• Crowdfund platform down — check Coolify dashboard`;
        if (f.service.includes('Centrifugo')) return `• Realtime server down — check Centrifugo container logs`;
        return `• ${f.service} is down — investigate manually`;
      });

      prompt.note(
        [
          c.yellow('Some services are having issues. Here are suggestions:'),
          '',
          ...suggestions
        ].join('\n'),
        '⚠️  Issues Found'
      );
    }

    const allUp = failures.length === 0;
    const slowCount = results.filter(r => r.status === 'slow').length;

    return {
      success: true,
      summary: allUp
        ? (slowCount > 0 ? `All services up, but ${slowCount} running slow.` : 'All services healthy! ✓')
        : `${failures.length} service(s) down: ${failures.map(f => f.service).join(', ')}`,
      details: { results }
    };
  }
};

export default runbook;
