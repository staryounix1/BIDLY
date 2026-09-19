# BIDLY — 18. Phase 3 Scope

Phase 3 is about **intelligence, scale and enterprise** — turning the platform into infrastructure other
businesses can build on, without ever letting AI make irreversible financial decisions (spec §72).

## 18.1 AI-assisted marketplace (optional & modular)

All AI goes through the `AiProvider` interface, is feature-flagged, is logged for auditability, and
never performs an irreversible financial action without human confirmation.

| Capability | Behaviour | Guardrail |
|---|---|---|
| NL → structured request | "Move my couch tomorrow morning from Brooklyn to Queens, ~$80" becomes a filled draft | User must review and confirm every extracted field before publish |
| Photo → item/quantity estimation | Estimate volume from photos for moving jobs | Presented as a suggestion; provider and customer can override |
| Missing-info detection | "Requests with photos get 3× more offers — add one?" | Advisory only |
| Category suggestion | Suggest the right category from a free-text description | User confirms |
| Smart budget guidance | Suggest a competitive range from historical accepted prices in the area | Transparent basis; never blocks a legitimate budget |
| Provider matching insights | Explain why a provider did/didn't see a request | Read-only explanation |
| Message translation | Translate chat both ways | Labelled as machine translation |
| Reply suggestions for providers | Draft responses from templates + context | Provider edits before sending |
| Support agent assist | Summarise a ticket, propose a policy-grounded reply | Agent approves |
| Content safety | Detect scams, prohibited items, off-platform payment requests | Flags for review; auto-block only for illegal content with human appeal |
| Fraud copilot | Rank risk cases by likely severity and explain factors | Human decides; no automatic bans (§31) |
| Demand forecasting | Predict per-category demand by area/time | Used for provider recruitment |

**Design rules:** AI output is always structured (JSON-validated), always attributable (which model,
which prompt version), never used as the sole basis for a payment, refund, ban, or account deletion, and
always disclosed when it is talking to a human (e.g. support auto-responses).

## 18.2 Service extraction & scale architecture
- Extract the highest-volume modules into independently deployable services, in this order:
  **payments → messaging/realtime → matching → notifications**
- Event backbone (Kafka or NATS) replacing the outbox worker for cross-service events, with an
  outbox bridge during migration
- CQRS read models for dashboards and provider feeds
- Multi-region read replicas; regional write sharding only if data-residency requires it
- PostGIS everywhere, plus routing/h3-based dispatch for dense metros
- Edge caching for catalog and public provider profiles

## 18.3 Enterprise & B2B
- BIDLY for Business: bulk requests, recurring service contracts (e.g. weekly office cleaning),
  managed provider pools, SLAs
- API access for partners: create requests programmatically, receive offers via webhook, embed the
  request flow in a partner app
- White-label / embedded marketplace for large customers
- Procurement integrations (invoice matching, POs, approval chains)
- Fleet and multi-location management with per-location budgets and reporting

## 18.4 Financial services layer
- Insurance products for high-value jobs (partner-underwritten), purchased in the job flow
- Job-value financing / instalments where regulation allows
- Provider working-capital advances based on verified earnings history
- Escrow-as-a-service for third-party marketplaces
- Tax withholding automation per country with reporting-ready exports

## 18.5 Advanced marketplace optimisation
- Dynamic commission experimentation (per category × geo, with guardrails and no provider surprises)
- Liquidity-aware dispatch: prefer providers whose acceptance makes the marketplace healthier
- Automated provider recruitment targeting (which city/category needs supply)
- Reputation portability across categories with category-scoped ratings
- Anti-gaming system with graph analysis of collusion rings

## 18.6 Platform & developer experience
- Public developer portal with sandbox, API keys, webhooks, SDKs (JS, Python, mobile)
- Marketplace apps / provider API for tool inventory and job management systems
- Data warehouse (analytics store) with BI tooling and self-serve dashboards
- Self-serve market launch kit: an admin can stand up a new country (currency, tax, legal docs, PSP,
  notification templates, commission rules) without engineering involvement
- Compliance automation: regional document templates, consent versioning, data-residency controls

## 18.7 Mobile & reach
- Native iOS + Android apps (React Native/Expo) sharing the API and type packages
- Offline-first provider app for low-connectivity markets
- Voice-note requests and chat for accessibility and literacy diversity
- Low-bandwidth mode; SMS/USSD request creation for feature-phone markets

## 18.8 Reliability & governance at scale
- Multi-region active-passive with documented failover and rehearsed drills
- 99.95% API SLO with error budgets gating feature releases
- Formal change management: canary deploys, automated rollback on SLO burn
- Security certifications as markets require them (PCI-DSS SAQ-A maintained, SOC 2 roadmap)
- Automated data-residency routing so EU data can stay in the EU
