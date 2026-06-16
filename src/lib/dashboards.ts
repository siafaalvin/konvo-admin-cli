/**
 * Registry of all dashboards / web UIs / API endpoints an operator
 * might need to manage the Konvo PWA. Single source of truth — adding
 * a new service means one entry here, and runbooks (open-dashboard,
 * sites-and-dashboards) pick it up automatically.
 *
 * Mirrors `planning/houvox/OPS-URLS.md` in the houvox-pwa repo.
 * If the doc and this file ever drift, OPS-URLS.md is canonical for
 * narrative + step-by-step Phase D setup; this file is canonical for
 * the at-a-glance dashboard list + login methods.
 */

export interface Dashboard {
  /** Kebab-case key, used in CLI menu + audit slug. */
  id:           string;
  /** Human label. */
  name:         string;
  /**
   * Direct link. For tunnel-required services this is the localhost
   * URL the operator opens AFTER establishing the tunnel.
   */
  url:          string;
  category:     'app' | 'infra' | 'service' | 'reference';
  /** Optional one-liner shown in CLI hints. */
  notes?:       string;
  /**
   * Tunnel-only services (Coolify) — runbooks switch from "open in
   * browser" to "print SSH-tunnel command + manual open" when set.
   */
  needsTunnel?: boolean;
  /**
   * Verbatim SSH tunnel command for the operator to copy. Only set
   * when needsTunnel = true.
   */
  tunnelCommand?: string;
  /**
   * How the operator authenticates. Optional but recommended on every
   * entry — populate even if it's "Public, no login required" so the
   * reference output is complete.
   */
  auth?:        AuthInfo;
}

export interface AuthInfo {
  /**
   * Short label for the auth method.
   *   'public'        — no login (e.g. PWA itself)
   *   'username/pass' — basic auth or form login with a u/p combo
   *   'sso'           — Google / GitHub / etc. social sign-in
   *   'api-token'     — programmatic-only access (no UI)
   *   'cloudflare-mfa', 'stripe-mfa', etc. — well-known SaaS portals
   *                                          with mandatory 2FA
   */
  method:               'public' | 'username/pass' | 'sso' | 'api-token' | 'mfa-portal';
  /**
   * Human-readable description of how to log in. Always include for
   * any non-public entry.
   */
  description:          string;
  /**
   * Where to find credentials. Pointers, not values — the registry
   * never holds secrets.
   */
  credentialsLocation?: string;
}

export const DASHBOARDS: Dashboard[] = [
  // ─── Production app surfaces ───────────────────────────────────────
  {
    id: 'app',
    name: 'PWA — app.thekonvo.com',
    url: 'https://app.thekonvo.com',
    category: 'app',
    notes: 'Public-facing PWA. Sign in with a real Konvo account to test as a user.',
    auth: {
      method: 'username/pass',
      description: 'Konvo account — email + password (or magic-link). Use a test account from /root/.konvo-prod/test-accounts.txt on the VPS.',
      credentialsLocation: 'VPS: /root/.konvo-prod/test-accounts.txt (mode 600)'
    }
  },
  {
    id: 'studio',
    name: 'Supabase Studio — studio.thekonvo.com',
    url: 'https://studio.thekonvo.com',
    category: 'app',
    notes: 'Full DB admin: tables, RLS, SQL editor, auth users, storage.',
    auth: {
      method: 'username/pass',
      description: 'HTTP basic auth. Username + password set as DASHBOARD_USERNAME / DASHBOARD_PASSWORD env vars on the supabase service.',
      credentialsLocation: 'VPS: grep -E "^DASHBOARD_(USERNAME|PASSWORD)=" /data/coolify/services/hoc46cx1c1qd643gkaqxhezq/.env'
    }
  },
  {
    id: 'analytics',
    name: 'Plausible — analytics.thekonvo.com',
    url: 'https://analytics.thekonvo.com',
    category: 'app',
    notes: 'Self-hosted Plausible. Page views, referrers, conversions.',
    auth: {
      method: 'username/pass',
      description: 'Email + password registered at first install. First account signed up is the admin/owner.',
      credentialsLocation: 'Operator personal vault (1Password / browser keychain). Not stored on VPS.'
    }
  },
  {
    id: 'crowdfund',
    name: 'Crowdfund platform — crowdfunding.thekonvo.com',
    url: 'https://crowdfunding.thekonvo.com',
    category: 'app',
    notes: 'Backer pledge + campaign portal (Next.js). Successful Stripe checkouts flow into Konvo crowdfund_emails via /v1/crowdfund/upsert worker route → backers get pricing_band=campaign on Konvo signup.',
    auth: {
      method: 'username/pass',
      description: 'Supabase Auth (separate Supabase project from Konvo). Admin dashboard at /admin gates on profiles.is_admin column.',
      credentialsLocation: 'Operator personal vault. First admin set via SQL: update profiles set is_admin=true where id=...'
    }
  },
  {
    id: 'crowdfund-supabase',
    name: 'Crowdfund Supabase — ahfipxppbnneadwxbfvq',
    url: 'https://supabase.com/dashboard/project/ahfipxppbnneadwxbfvq',
    category: 'infra',
    notes: 'SEPARATE Supabase project from Konvo. Runs the crowdfund-platform DB (8 tables: profiles, projects, contributions, reward_tiers, beta_access, blog_posts, timeline_events, beta_signups).',
    auth: {
      method: 'mfa-portal',
      description: 'Supabase account login. Same account as the Konvo project; access controlled per-project.',
      credentialsLocation: 'Operator personal vault. Service-role key used by the platform is in /Applications/Projects/crowdfund-platform/.env.local (and Coolify prod env).'
    }
  },
  {
    id: 'api',
    name: 'Supabase API — api.thekonvo.com',
    url: 'https://api.thekonvo.com',
    category: 'app',
    notes: 'No UI — REST + auth + realtime endpoint. Use curl with anon/service-role JWT for diagnostics.',
    auth: {
      method: 'api-token',
      description: 'JWT bearer. Anon key for public reads; service-role key for admin-bypass operations. Never expose service-role to browsers.',
      credentialsLocation: 'VPS: grep -E "^(ANON_KEY|SERVICE_ROLE_KEY)=" /data/coolify/services/hoc46cx1c1qd643gkaqxhezq/.env'
    }
  },
  {
    id: 'worker',
    name: 'verification-worker — worker.thekonvo.com',
    url: 'https://worker.thekonvo.com',
    category: 'app',
    notes: 'No UI — Fastify HTTP API. Health check at /healthz, billing at /v1/billing/*, dispatch at /v1/notifications/dispatch.',
    auth: {
      method: 'api-token',
      description: 'Bearer token (DISPATCH_SHARED_SECRET) for /v1/notifications/dispatch. Other routes are open or session-authenticated via Supabase JWT.',
      credentialsLocation: 'VPS: cat /root/.konvo-prod/dispatch-shared-secret.txt'
    }
  },
  {
    id: 'centrifugo',
    name: 'Centrifugo — rt.thekonvo.com',
    url: 'https://rt.thekonvo.com',
    category: 'app',
    notes: 'No UI — WebSocket realtime. Dashboard available via Centrifugo admin endpoint when CENTRIFUGO_ADMIN=true.',
    auth: {
      method: 'api-token',
      description: 'Per-channel HMAC tokens issued by the worker. Admin dashboard (if enabled) uses CENTRIFUGO_ADMIN_PASSWORD.',
      credentialsLocation: 'VPS: docker exec konvo-centrifugo-prod env | grep CENTRIFUGO_'
    }
  },

  // ─── Infrastructure dashboards ─────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub repo — siafaalvin/houvox-pwa',
    url: 'https://github.com/siafaalvin/houvox-pwa',
    category: 'infra',
    notes: 'Source code, branches, Issues.',
    auth: {
      method: 'sso',
      description: 'GitHub account with collaborator access. Use SSH key (~/.ssh/id_ed25519) for git operations; gh CLI uses OAuth.',
      credentialsLocation: 'gh auth status — if not logged in, run gh auth login.'
    }
  },
  {
    id: 'github-prs',
    name: 'GitHub open PRs',
    url: 'https://github.com/siafaalvin/houvox-pwa/pulls',
    category: 'infra',
    auth: {
      method: 'sso',
      description: 'Same as GitHub repo entry — collaborator access required to merge.'
    }
  },
  {
    id: 'github-actions',
    name: 'GitHub Actions — CI runs',
    url: 'https://github.com/siafaalvin/houvox-pwa/actions',
    category: 'infra',
    notes: 'CI builds + checks. Currently locked due to billing — see /tmp/billing-status if active.',
    auth: {
      method: 'sso',
      description: 'Same as GitHub repo entry.'
    }
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare dashboard',
    url: 'https://dash.cloudflare.com/',
    category: 'infra',
    notes: 'DNS, Pages, Email Routing, WAF. The PWA env vars live under Pages → houvox-pwa → Settings.',
    auth: {
      method: 'mfa-portal',
      description: 'Cloudflare account. 2FA enforced — use TOTP from authenticator app or hardware key.',
      credentialsLocation: 'Operator personal vault.'
    }
  },
  {
    id: 'cloudflare-pages',
    name: 'Cloudflare Pages — houvox-pwa project',
    url: 'https://dash.cloudflare.com/?to=/pages/view/houvox-pwa',
    category: 'infra',
    notes: 'PWA build env vars (PUBLIC_MAPTILER_KEY, PUBLIC_VAPID_PUBLIC_KEY, PUBLIC_*) + deploy history.',
    auth: {
      method: 'mfa-portal',
      description: 'Same as Cloudflare dashboard — single account.'
    }
  },
  {
    id: 'coolify',
    name: 'Coolify — production VPS dashboard',
    url: 'http://localhost:8000',
    category: 'infra',
    needsTunnel: true,
    tunnelCommand: 'ssh -L 8000:localhost:8000 -i ~/.ssh/id_ed25519 root@5.78.237.171',
    notes: 'Container env vars, restarts, logs. Coolify itself is not exposed publicly — must tunnel via SSH first.',
    auth: {
      method: 'username/pass',
      description: 'Email + password. The first admin account was registered at install time; additional teammates must be invited from inside Coolify Settings → Members.',
      credentialsLocation: 'Operator personal vault. Reset via Coolify CLI inside the coolify container if locked out: docker exec -it coolify php artisan password:reset <email>'
    }
  },
  {
    id: 'hetzner',
    name: 'Hetzner Cloud console',
    url: 'https://console.hetzner.cloud/',
    category: 'infra',
    notes: 'VPS resize, snapshots, network rules, billing.',
    auth: {
      method: 'mfa-portal',
      description: 'Hetzner account with 2FA. Project: konvo-prod. Server: 5.78.237.171 (production).',
      credentialsLocation: 'Operator personal vault.'
    }
  },

  // ─── External services ─────────────────────────────────────────────
  {
    id: 'stripe',
    name: 'Stripe dashboard',
    url: 'https://dashboard.stripe.com/',
    category: 'service',
    notes: 'Live keys, products, webhooks, refunds, customer payments.',
    auth: {
      method: 'mfa-portal',
      description: 'Email + password + 2FA. View-only roles available for support staff.',
      credentialsLocation: 'Operator personal vault. Live secret keys at VPS: /root/.konvo-prod/stripe-secret-key.txt (mode 600).'
    }
  },
  {
    id: 'stripe-webhooks',
    name: 'Stripe webhooks',
    url: 'https://dashboard.stripe.com/webhooks',
    category: 'service',
    notes: 'Endpoint: worker.thekonvo.com/v1/billing/webhook. Signing secret at VPS: /root/.konvo-prod/stripe-webhook-secret.txt.',
    auth: {
      method: 'mfa-portal',
      description: 'Same as Stripe dashboard.'
    }
  },
  {
    id: 'resend',
    name: 'Resend — transactional email',
    url: 'https://resend.com/dashboard',
    category: 'service',
    notes: 'Email logs, API keys, domain verification (thekonvo.com SPF/DKIM). Used for waitlist milestones + future password reset.',
    auth: {
      method: 'mfa-portal',
      description: 'Email + password + 2FA. API key at VPS: /root/.konvo-prod/resend-api-key.txt.',
      credentialsLocation: 'Operator personal vault for portal login. API key at VPS path above.'
    }
  },
  {
    id: 'maptiler',
    name: 'MapTiler Cloud — map tiles + geocoding',
    url: 'https://cloud.maptiler.com/',
    category: 'service',
    notes: 'Public PWA map background + worker-side geocoding. Domain restrictions on the public key are critical.',
    auth: {
      method: 'username/pass',
      description: 'Email + password. The PUBLIC_MAPTILER_KEY for the PWA must have allowed-origins set to thekonvo.com + *.thekonvo.com + localhost.',
      credentialsLocation: 'Operator personal vault for portal login. Worker-side key at VPS: /root/.konvo-prod/maptiler-key.txt.'
    }
  },
  {
    id: 'google-ava',
    name: 'Google Cloud — Address Validation API',
    url: 'https://console.cloud.google.com/',
    category: 'service',
    notes: 'Geocode chain debugging, IP allowlist, quota dashboard.',
    auth: {
      method: 'sso',
      description: 'Google account with billing access on the konvo-prod GCP project. API key at VPS: /root/.konvo-prod/google-ava-key.txt.',
      credentialsLocation: 'Operator personal Google account. Service account JSON not used (legacy API key auth).'
    }
  },
  {
    id: 'usps',
    name: 'USPS Developer portal',
    url: 'https://developer.usps.com/',
    category: 'service',
    notes: 'OAuth client setup (replaced legacy XML API). Credentials at VPS: /root/.konvo-prod/usps-oauth-*.txt.',
    auth: {
      method: 'username/pass',
      description: 'USPS Business Customer Gateway login + Developer Portal app registration.',
      credentialsLocation: 'Operator personal vault.'
    }
  },
  {
    id: 'uptimerobot',
    name: 'UptimeRobot — uptime monitoring',
    url: 'https://uptimerobot.com/',
    category: 'service',
    notes: 'Monitors /healthz on app, api, worker, rt. Alerts via email + push.',
    auth: {
      method: 'username/pass',
      description: 'Email + password. Free tier covers all 4 prod monitors.'
    }
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
