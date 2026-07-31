# Konvo Operator Quick Reference

## Getting Started

```bash
cd /Applications/Projects/konvo-admin-cli
bun run start           # Normal mode
bun run start --dry-run # Training mode (no changes made)
```

## Daily Workflow (in order)

| # | Command | What it does |
|---|---------|-------------|
| 1 | `Triage` | Dashboard overview — see alerts, pending flags, stuck users |
| 2 | `Review Next Flag` | Pull oldest flag → Dismiss / Warn / Remove / Suspend |
| 3 | `Review Next Appeal` | Pull oldest appeal → Approve / Deny |
| 4 | `View Alerts` | Check system alerts that need acknowledgment |
| 5 | `Check System Health` | Verify all services are running |

## Action Color Guide

| Color | Meaning |
|-------|---------|
| 🟢 Green | Safe action — read-only, no changes |
| 🟡 Yellow | Moderate — requires judgment, reversible |
| 🔴 Red | Destructive — suspensions, deletions, irreversible |

## Training Mode (`--dry-run`)

Run any command with `--dry-run` flag to see what WOULD happen without making changes. Use this for your first week.

```bash
bun run start --dry-run
```

Every action shows `[DRY RUN]` prefix instead of executing.

## Common Scenarios

### "A user posted spam"
1. `Review Next Flag` → select the flag
2. If clearly spam → `Remove` (deletes post)
3. If repeat offender → `Suspend`

### "Someone appealed their suspension"
1. `Review Next Appeal`
2. Read the appeal reason + original flag
3. If the original action was too harsh → `Approve` (restores account)
4. If the action was justified → `Deny`

### "A user is stuck in verification"
1. `Triage` → see stuck users count
2. Select "Help stuck user" from triage menu
3. Follow prompts to manually verify or reset their zone

### "Something seems down"
1. `Check System Health` → shows status of all services
2. If a service is down → `Restart Service` → select the service
3. If restart doesn't help → escalate to @siafaalvin

## Rules of Engagement

1. **When in doubt, skip.** Come back to it or escalate.
2. **Suspensions are serious.** Always double-check before suspending.
3. **Dismiss ≠ approve.** Dismissing a flag means the content is OK, not that you agree with it.
4. **Patterns matter more than single posts.** One borderline post = warn. Three = escalate.
5. **Never share screenshots of user data.** All operator access is logged.

## Escalation

If you encounter something you're unsure about:
- Skip the item (it stays in the queue)
- Message @siafaalvin with the flag/appeal ID
- Never guess on suspension decisions

## Schedule

- **Shift:** 10 hours/week, flexible scheduling
- **Priority:** Flags first, then appeals, then stuck users
- **Response time:** Within 24 hours of flag submission
