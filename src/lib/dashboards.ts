/**
 * Registry of all dashboards / web UIs an operator might need. Single
 * source of truth — adding a new service means one entry here, and
 * runbooks 10 + future "audit which services are configured" pick it
 * up automatically.
 *
 * Mirrors `planning/houvox/OPS-URLS.md` in the houvox-pwa repo.
 * If the doc and this file ever drift, OPS-URLS.md is canonical.
 */

export interface Dashboard {
  id:           string;          // kebab-case key, used in CLI menu
  name:         string;          // human label
  url:          string;          // direct link (or instructions for tunnel-required)
  category:     'app' | 'infra' | 'service' | 'reference';
  notes?:       string;          // optional one-liner for the operator
  needsTunnel?: boolean;         // true → 'open' will print SSH-tunnel instructions instead
}

export const DASHBOARDS: Dashboard[] = [
  // ─── Production app surfaces ───────────────────────────────────────
  {
    id: 'app',
    name: 'PWA (app.thekonvo.com)',
    url: 'https://app.thekonvo.com',
    category: 'app'
  },
  {
    id: 'studio',
    name: 'Supabase Studio',
    url: 'https://studio.thekonvo.com',
    category: 'app',
    notes: 'Full DB admin: tables, RLS, SQL editor, auth users.'
  },
  {
    id: 'analytics',
    name: 'Plausible analytics',
    url: 'https://analytics.thekonvo.com',
    category: 'app'
  },

  // ─── Infrastructure dashboards ─────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub repo',
    url: 'https://github.com/siafaalvin/houvox-pwa',
    category: 'infra'
  },
  {
    id: 'github-prs',
    name: 'GitHub open PRs',
    url: 'https://github.com/siafaalvin/houvox-pwa/pulls',
    category: 'infra'
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare dashboard',
    url: 'https://dash.cloudflare.com/',
    category: 'infra',
    notes: 'DNS, Pages, Email Routing, WAF.'
  },
  {
    id: 'cloudflare-pages',
    name: 'Cloudflare Pages — houvox-pwa',
    url: 'https://dash.cloudflare.com/?to=/pages/view/houvox-pwa',
    category: 'infra',
    notes: 'PWA build env vars + deploys.'
  },
  {
    id: 'coolify',
    name: 'Coolify (production VPS)',
    url: 'http://localhost:8000',
    category: 'infra',
    needsTunnel: true,
    notes: 'Requires SSH tunnel: ssh -L 8000:localhost:8000 root@5.78.237.171'
  },

  // ─── External services ─────────────────────────────────────────────
  {
    id: 'stripe',
    name: 'Stripe dashboard',
    url: 'https://dashboard.stripe.com/',
    category: 'service'
  },
  {
    id: 'stripe-webhooks',
    name: 'Stripe webhooks',
    url: 'https://dashboard.stripe.com/webhooks',
    category: 'service',
    notes: 'Endpoint at worker.thekonvo.com/v1/billing/webhook.'
  },
  {
    id: 'resend',
    name: 'Resend (transactional email)',
    url: 'https://resend.com/dashboard',
    category: 'service',
    notes: 'Geofence-v2 reminder dispatch + future password reset email.'
  },
  {
    id: 'maptiler',
    name: 'MapTiler (geocoding)',
    url: 'https://cloud.maptiler.com/',
    category: 'service'
  },
  {
    id: 'google-ava',
    name: 'Google Cloud — Address Validation API',
    url: 'https://console.cloud.google.com/',
    category: 'service'
  },
  {
    id: 'usps',
    name: 'USPS Developer portal',
    url: 'https://developer.usps.com/',
    category: 'service'
  },
  {
    id: 'uptimerobot',
    name: 'UptimeRobot',
    url: 'https://uptimerobot.com/',
    category: 'service'
  },
  {
    id: 'hetzner',
    name: 'Hetzner Cloud console',
    url: 'https://console.hetzner.cloud/',
    category: 'service'
  }
];

/** Look up a dashboard by id. */
export function findDashboard(id: string): Dashboard | undefined {
  return DASHBOARDS.find((d) => d.id === id);
}

/** Group dashboards by category for nicer CLI menu rendering. */
export function dashboardsByCategory(): Record<Dashboard['category'], Dashboard[]> {
  return DASHBOARDS.reduce(
    (acc, d) => {
      acc[d.category].push(d);
      return acc;
    },
    { app: [], infra: [], service: [], reference: [] } as Record<Dashboard['category'], Dashboard[]>
  );
}

/**
 * Open a URL in the user's default browser. Uses `open` on macOS,
 * `xdg-open` on Linux, `start` on Windows. Returns true if the spawn
 * call resolved with exit code 0.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  const cmd =
    platform === 'darwin'  ? ['open', url] :
    platform === 'win32'   ? ['cmd', '/c', 'start', '', url] :
                              ['xdg-open', url];
  const proc = Bun.spawn({ cmd, stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await proc.exited;
  return exitCode === 0;
}
