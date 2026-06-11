/**
 * Canonical service registry. Single source of truth for which
 * containers a runbook can interact with — referenced by tail-logs,
 * restart-service, and any future ops runbook that needs to address
 * a specific service.
 *
 * Why a registry instead of free-form input?
 *   - Coolify suffixes container names with random hashes. Operators
 *     shouldn't have to remember `supabase-db-hoc46cx1c1qd643gkaqxhezq`.
 *   - The pattern field lets us resolve the live name via
 *     `docker ps | grep -E '^pattern'` at run time.
 *   - Capability flags let runbooks filter the picker (e.g. restart
 *     hides supabase-db; logs shows everything).
 */

export interface Service {
  /** Stable id used in CLI options + audit log entries. */
  id: string;
  /** Friendly label shown in the picker. */
  label: string;
  /** Regex anchored to match `docker ps` output. */
  pattern: string;
  /** One-liner for the picker hint. */
  hint: string;
  /**
   * `restartable: false` for services where a plain `docker restart`
   * would cause meaningful blast radius (Postgres being the obvious
   * one — restarting it severs every other Supabase service plus
   * the worker's pool).
   */
  restartable: boolean;
}

export const SERVICES: Service[] = [
  {
    id:          'worker',
    label:       'konvo-worker-prod',
    pattern:     '^konvo-worker-prod$',
    hint:        'Background jobs, geofence-v2 scheduler, dispatch',
    restartable: true
  },
  {
    id:          'centrifugo',
    label:       'konvo-centrifugo-prod',
    pattern:     '^konvo-centrifugo-prod$',
    hint:        'Realtime websocket — chat fan-out',
    restartable: true
  },
  {
    id:          'supabase-db',
    label:       'supabase-db (Postgres)',
    pattern:     '^supabase-db-',
    hint:        'Postgres logs — queries, errors, replication',
    // Restarting Postgres severs every other Supabase service + the
    // worker pool. Operators should plan a window, not click restart.
    restartable: false
  },
  {
    id:          'supabase-auth',
    label:       'supabase-auth',
    pattern:     '^supabase-auth-',
    hint:        'GoTrue — sign-up, sign-in, password reset',
    restartable: true
  },
  {
    id:          'supabase-rest',
    label:       'supabase-rest (PostgREST)',
    pattern:     '^supabase-rest-',
    hint:        'REST API surface',
    restartable: true
  },
  {
    id:          'supabase-storage',
    label:       'supabase-storage',
    pattern:     '^supabase-storage-',
    hint:        'Document uploads, storage API',
    restartable: true
  }
];

export function findService(id: string): Service | undefined {
  return SERVICES.find((s) => s.id === id);
}

export function restartableServices(): Service[] {
  return SERVICES.filter((s) => s.restartable);
}
