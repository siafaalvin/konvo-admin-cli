# Konvo Operator Scaling Plan

**Wage floor:** $200/hr × 10 hrs/week = $2,000/week per operator

**Scope:** Consumer users only (excludes business badge holders, enterprise, and government accounts)

---

## Scaling Table

| Users | Operators | Weekly Cost | Monthly Cost | Annual Cost | Min Revenue to Cover (at $5/yr avg) | Notes |
|---|---|---|---|---|---|---|
| **69** (current) | 0 | $0 | $0 | $0 | — | You + automation only |
| **5,000** | 0 | $0 | $0 | $0 | — | Automation + you handles everything |
| **25,000** | 2 | $4,000 | $17K | $208K | 42K users | First hires: 1 morning, 1 afternoon (10h each) |
| **100,000** | 4 | $8,000 | $35K | $416K | 83K users | Add night coverage + float |
| **250,000** | 6 | $12,000 | $52K | $624K | 125K users | 2 per shift, minimal overlap |
| **500,000** | 10 | $20,000 | $87K | $1.04M | 208K users | Full 3-shift coverage begins |
| **1,000,000** | 16 | $32,000 | $139K | $1.66M | 333K users | Moderation specialization starts |
| **2,000,000** | 24 | $48,000 | $208K | $2.5M | 500K users | Dedicated mod + support + billing teams |
| **3,000,000** | 32 | $64,000 | $277K | $3.3M | 666K users | Shift leads added |
| **6,000,000** | 48 | $96,000 | $416K | $5.0M | 1M users | Full target team, 18h coverage |
| **10,000,000** | 64 | $128,000 | $554K | $6.6M | 1.3M users | 24h coverage, regional specialists |
| **25,000,000** | 100 | $200,000 | $866K | $10.4M | 2.1M users | Tiered support (L1/L2), dedicated appeals |
| **50,000,000** | 140 | $280,000 | $1.2M | $14.6M | 2.9M users | Language/region teams |
| **100,000,000** | 200 | $400,000 | $1.7M | $20.8M | 4.2M users | Full global ops |

---

## Key Ratios

| Metric | Value |
|---|---|
| Operator cost per user per year | $0.21 at 100M users |
| Users per operator | ~500K at scale |
| Revenue headroom ($5/yr avg) | Operators = 4.2% of revenue at 100M |
| Revenue headroom ($10/yr avg) | Operators = 2.1% of revenue at 100M |

---

## Hiring Triggers

| Trigger | Action |
|---|---|
| **25K users** | Hire first 2 operators (you can no longer personally handle every edge case) |
| **100K users** | Hire 2 more (night coverage, you stop checking alerts yourself) |
| **500K users** | You fully step back from operations; 10 operators own it |

---

## Assumptions

- All operators work **10 hours/week** at **$200/hr**
- Automation (n8n + LocalAI) handles 90%+ of routine tasks
- Operators handle exceptions only: edge-case support, moderation review, billing disputes
- At 100M users earning $5/yr avg = **$500M/yr revenue** vs. $20.8M operator cost = **4.2%**
- Business badge holders, enterprise, and government accounts add revenue without proportional support load (separate cost center)
- "Min Revenue to Cover" = users needed at $5/yr *just* to pay operators (actual break-even higher with infra + engineering)
