# Konvo Admin CLI — Triage Flow & Dashboard Plan

## Team Structure (Lean)

| Role | Count | Responsibility |
|---|---|---|
| Siafa (Founder/CEO) | 1 | Product decisions, escalations, @siafaayye voice |
| Engineers | 2 | Platform development, infrastructure, automation |
| CLI Operators | 8–12 | Support, moderation, verification review, billing |

### Why 8–12 Operators for 6M Active Users

- **Support ratio:** 1 operator per 500K–750K users (industry standard for automated-first platforms)
- **Shift coverage:** 3 shifts × 3 operators + 1–2 floaters for peaks/PTO
- **Specialization:** 2 focused on moderation, 2 on verification/billing, 2 on support, remainder flex
- **Automation handles 90%+:** n8n workflows manage expiry, reminders, alerts. Operators handle exceptions only.

---

## Phase 1: Triage Entry Point

Replace the current flat runbook picker with a guided decision tree.

### On CLI Launch

```
╭──────────────────────────────────────────────╮
│  Konvo Admin CLI — Good morning, [operator]  │
│                                              │
│  ⚠️  3 alerts   📝 2 pending reviews         │
│  👤 1 stuck user   💳 0 payment issues       │
│                                              │
│  Last 24h: 142 signups, 89 verified,         │
│  4 suspensions, $312 revenue                 │
╰──────────────────────────────────────────────╯

What do you need to do?

  ○ 🆘 Help a user (support ticket / DM)
  ○ 🛡️ Review flagged content
  ○ 📝 Review bot replies (2 pending)
  ○ ⚠️ Check system alerts (3 new)
  ○ 🔍 Look up a user
  ○ 💳 Billing / payment issue
  ○ ✅ Daily check-in (guided routine)
  ○ ⚙️ Advanced (full runbook list)
```

### Triage Paths

#### "🆘 Help a user"
```
What's the user's issue?

  ○ "I paid but can't get in"
      → inspect-user → check access_paid_at
      → if null: mark-user-paid or check crowdfund
      → if set: check tier, check ban status

  ○ "My location won't verify"
      → inspect-user → check geofence checks
      → if accuracy >300m: send GPS fix instructions
      → if 5 attempts used: offer manual-verify or vouch

  ○ "I'm not getting notifications"
      → inspect-user → check push_subscriptions
      → if 0: "Ask them to re-enable notifications in Settings"
      → if >0: check failure_count, offer test-worker-dispatch

  ○ "I can't see someone's profile"
      → likely the username/platform_id resolution bug (now fixed)
      → check if target user exists

  ○ "I want to delete my account"
      → suspend-user (permanent) + note: data retained 30 days

  ○ "Someone is harassing me"
      → look up reported user → review posts → suspend/delete
      → send template: "We've reviewed and taken action"

  ○ Other (freeform)
      → inspect-user → show state → operator decides
```

#### "🛡️ Review flagged content"
```
→ Show queue of flagged posts (ordered by flag count, severity)
→ For each: show content, flag reason, flag count, author history
→ Actions: Dismiss | Warn | Delete Post | Suspend Author
→ Auto-send template notification to reporter: "Thanks for flagging"
```

#### "✅ Daily check-in"
```
Step 1: Check system health (auto-run)
Step 2: Review alerts (show + dismiss)
Step 3: Review pending bot replies (approve/reject)
Step 4: Check stuck users (pending >7 days)
Step 5: Check expiring vouches (remind or extend)
Step 6: Moderation queue (if any flagged content)
Step 7: Summary: "All clear" or "X items need attention"
```

#### "💳 Billing / payment issue"
```
  ○ User says they paid but no access → mark-user-paid
  ○ User wants a refund → process-refund (new runbook)
  ○ User's subscription expired → extend-subscription (new runbook)
  ○ Crowdfund backer not recognized → check crowdfund_emails table
```

---

## Phase 2: Context Persistence

After any user lookup, maintain a "current user" context that auto-fills subsequent actions.

### Implementation

```typescript
// In RunbookContext:
interface RunbookContext {
  config: Config;
  prompt: typeof p;
  dryRun: boolean;
  // NEW: persisted context from previous action
  currentUser?: {
    userId: string;
    email: string;
    platformId: string;
    tier: string;
  };
}
```

After `inspect-user`, `change-user-tier`, etc. complete:
- Store the user in context
- Next runbook auto-offers: "Same user ([platform_id])? [Y/n]"
- Eliminates re-typing email for chained actions

---

## Phase 3: Runbook Chaining

When a runbook completes, offer logical next actions:

| After... | Offer... |
|---|---|
| inspect-user (unpaid) | "Mark as paid?" → mark-user-paid |
| inspect-user (stuck verification) | "Reset geofence?" or "Verify manually?" |
| inspect-user (suspended) | "Unsuspend?" → suspend-user |
| delete-post | "Suspend the author?" → suspend-user |
| change-user-tier (downgrade) | "Send notification email?" → send-template |
| verify-address-manually | "Send confirmation email?" → send-template |

---

## Phase 4: New Runbooks Needed

### Priority 1 (Week 1)

| Runbook | Description |
|---|---|
| `triage` | Meta-runbook: the decision tree entry point |
| `daily-checkin` | Guided daily routine (health → alerts → queues) |
| `send-email-template` | Pick a template, fill user email, send via Resend |
| `process-refund` | Look up user's Stripe payment → issue refund |
| `extend-subscription` | Add 30 days to tier_expires_at |

### Priority 2 (Week 2)

| Runbook | Description |
|---|---|
| `view-flagged-content` | Show flagged posts queue with actions |
| `bulk-delete-user-posts` | Delete all posts by a user (pre-suspension cleanup) |
| `view-stuck-users` | Users pending >7 days with no geofence progress |
| `resend-notification` | Manually trigger a push to a specific user |
| `view-user-timeline` | Chronological history: signup → payment → verification → first post |

### Priority 3 (Week 3)

| Runbook | Description |
|---|---|
| `operator-shift-handoff` | Generate summary of open items for next shift |
| `bulk-action` | Select multiple users → apply same action (tier change, grant, etc.) |
| `search-posts-by-content` | Find posts containing a keyword (for investigation) |
| `export-user-data` | GDPR-style data export for a requesting user |

---

## Phase 5: Dashboard Metrics (on launch)

Computed by a single SQL query on CLI startup:

```sql
SELECT
  (SELECT count(*) FROM system_alerts WHERE acknowledged_at IS NULL) as unread_alerts,
  (SELECT count(*) FROM pending_bot_replies WHERE status = 'pending') as pending_reviews,
  (SELECT count(*) FROM address_residencies WHERE status = 'pending'
    AND geofence_v2_started_at < now() - interval '7 days') as stuck_users,
  (SELECT count(*) FROM auth.users WHERE created_at > now() - interval '24 hours') as signups_24h,
  (SELECT count(*) FROM address_residencies WHERE verified_at > now() - interval '24 hours') as verified_24h,
  (SELECT count(*) FROM profiles WHERE access_paid_at > now() - interval '24 hours') as paid_24h;
```

---

## Phase 6: Email Templates

Pre-written, variable-substituted, sent via Resend API:

| Template ID | Subject | When |
|---|---|---|
| `welcome_verified` | "Your address is verified!" | After manual verify or geofence pass |
| `gps_help` | "Trouble verifying? Try this" | After 2 failed checks (auto via n8n) |
| `post_removed` | "Your post was removed" | After delete-post |
| `account_suspended` | "Your account has been suspended" | After suspend-user |
| `account_unsuspended` | "Your account is back" | After unsuspend |
| `refund_processed` | "Your refund is on the way" | After process-refund |
| `vouch_reminder` | "Someone's waiting for your vouch" | Via n8n workflow |
| `flag_resolved` | "Thanks for reporting" | After reviewing flagged content |

Templates stored in `src/templates/*.txt` with `{{email}}`, `{{display_name}}`, `{{reason}}` variables.

---

## Phase 7: n8n Automation Additions

| Workflow | Schedule | Purpose |
|---|---|---|
| Stuck user detection | Daily 6 AM | Flags users pending >7 days → system_alerts |
| Daily operator summary | Daily 7 AM | Emails shift leads with overnight stats |
| Failed payment retry | Every 4h | Checks Stripe for recoverable failures |
| Flagged content threshold | Every 30 min | Auto-alerts when a post gets 3+ flags |

---

## Scaling Notes for 6M Users

### Automation Coverage Target

| Task | Automation % | Operator Involvement |
|---|---|---|
| Signup → verification → access | 98% automated | Only manual-verify edge cases |
| Payment processing | 99% automated | Only refund/dispute resolution |
| Content moderation | 85% automated (LocalAI + flag threshold) | Review queue for borderline cases |
| Support (general) | 70% deflected by templates | Complex issues escalated to operator |
| Account suspension | 60% automated (fine escalation) | Manual review for appeals |

### Operator Efficiency Targets

- **Average ticket resolution:** <3 minutes (triage → action → template)
- **Daily check-in:** <10 minutes per operator
- **Queue target:** Zero pending reviews older than 4 hours
- **Coverage:** 18h/day (3 shifts, off-hours handled by automation + alerts)

### System Resources at 6M Users

| Component | Current | At 6M |
|---|---|---|
| VPS | 1× 16GB Hetzner | 3–4× 32GB (app, DB, workers, n8n+AI) |
| Database | Single Supabase | Primary + read replica |
| Worker | 1 container | 3–4 containers behind load balancer |
| n8n | 1 instance | 1 (workflow engine scales vertically) |
| LocalAI | 1× Qwen 0.5B | Dedicated GPU instance (Mistral 7B+) |
| Centrifugo | 1 instance | 2–3 nodes (horizontally scalable) |
| CDN/Pages | Cloudflare (unlimited) | Same (auto-scales) |

---

## Implementation Order

1. **Week 1:** Triage flow + dashboard + daily check-in + email templates
2. **Week 2:** Context persistence + runbook chaining + refund/billing
3. **Week 3:** Flagged content queue + stuck user detection + bulk actions
4. **Week 4:** Operator shift handoff + GDPR export + scaling prep

**Total estimate:** ~40 hours of engineering across 4 weeks, resulting in a CLI that 8–12 non-technical operators can use to manage 6M users with minimal escalation to engineering.
