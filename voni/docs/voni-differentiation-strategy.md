# Voni differentiation strategy

**Decision document, 13 September 2026**

**Scope:** Product strategy and research, not a legal opinion or a claim of certified compliance.

## Executive decision

Voni should become the governed case-resolution platform for regulated organizations.

> Voni turns approved institutional policy into auditable cases that voice agents, employees, and external systems can advance safely over time.

The first lighthouse workflow should be **Proactive Application Resolution**: resolve a narrow, correctable application problem, such as a missing or expired document, without letting the AI decide eligibility, credit, pricing, fraud, sanctions, or whether evidence is acceptable.

This is a sharper position than a generic voice-agent builder. ElevenLabs already provides a strong horizontal conversation layer: agents, multilingual voices, telephony, WhatsApp, workflows, structured procedures, knowledge bases, tools, transfers, batch calls, testing, experiments, analytics, guardrails, versioning, workspace controls, private deployment, and enterprise privacy options.[^1] Voni will not win by reproducing those features.

Voni should own five things that remain valuable when the institution already uses ElevenLabs:

1. The **case**, which persists across calls, messages, people, providers, and source systems.
2. The **policy version** that governed each material statement and action.
3. The **authority decision** that determined who or what could act.
4. The **evidence chain** that reconstructs facts, wording, approvals, tool results, and execution receipts.
5. The **resolution plan and human queue** that continue after any single conversation ends.

ElevenLabs, AssemblyAI, telephony carriers, language models, document services, and customer systems should connect through adapters. They should never become the system of record for Voni's cases or authority.

The thesis is falsifiable. It fails if institutions are willing to keep all durable case state, policy approval, authority rules, and evidence in their existing CRM or case-management product while using a conversation provider directly. The first pilot must therefore test willingness to adopt Voni as the governed orchestration and evidence layer, not merely willingness to try an AI phone call.

## What the research changes

The strongest conclusion is narrower than “ElevenLabs cannot do regulated work.” That claim would be false.

ElevenLabs can execute structured procedures, require confirmation for MCP tools, transfer to people, call customer systems, export traces, retain or redact conversations, run tests, version agent configurations, and deploy in private environments.[^2] It also introduced conversation triage tickets with workspace lists, assignees, comments, and statuses. Its documentation explicitly describes these as tickets about an agent's performance on a conversation, for triage with Architect, rather than tickets an agent opens for end users.[^3]

The defensible gap is the relationship among controls. Public ElevenLabs documentation does not evidence a managed product that binds an institution's signed policy clauses, source facts, identity checks, role-based approvals, execution receipts, deadlines, disputes, and cross-session resolution state into one durable customer case. A customer can build that layer with tools, webhooks, a CRM, and its own database. That is the layer Voni should productize.

The strategic implication is direct:

- Workflows, guardrails, testing, security, queues, or multilingual speech alone are not differentiation.
- A voice-provider abstraction alone is useful architecture, but it is not a product moat.
- The product unit must change from **agent and campaign** to **policy-governed case and resolution outcome**.
- Voni's proof must show faster resolution with stronger control and reconstruction, not a more natural conversation demo.

## Research boundary and classification

This assessment uses public documentation available on 13 September 2026. Enterprise contracts can contain capabilities that are not public, and customer-built deployments can exceed the managed features described here. “Unsupported” below therefore means **not evidenced as a managed product in the public sources reviewed**, not technically impossible.

The capability matrix uses four classes:

| Code | Meaning |
| --- | --- |
| **N** | Native ElevenLabs managed capability. |
| **C** | Achievable through tools, integrations, webhooks, or customer-built infrastructure. |
| **U** | No managed product capability evidenced in the public documentation reviewed. |
| **X** | Components exist, but ElevenLabs is unsuitable as the sole owner of the regulated decision or case obligation. |

“X” does not mean the voice provider cannot participate. It means the institution needs a separate authority and system-of-record layer.

## ElevenLabs capability matrix

| Area | ElevenLabs capability and evidence | Class | Strategic meaning for Voni |
| --- | --- | :---: | --- |
| Agent creation | Prompts, LLM selection, voices, languages, knowledge, tools, personalization, authentication, and turn behavior are native.[^1] | N | Stop treating a guided generic agent builder as the core differentiator. Keep a focused configuration surface for the governed workflow. |
| Voice and language | Thousands of voices, multilingual operation, turn-taking, pronunciation controls, and voice settings are part of the platform.[^1] | N | Buy through an adapter. Compete on approved language variants, comprehension evidence, and outcome parity across languages. |
| Model choice | ElevenLabs supports several LLMs and custom LLM connections.[^1] | N | Normalize model events and retain institution-owned evaluations. Provider choice is an operational control, not the product promise. |
| Web and app channels | Web widget and SDKs for React, iOS, Android, and React Native are native.[^1] | N | Do not build commodity conversation clients except where the case experience requires them. |
| Telephony | SIP trunks, Twilio, outbound and inbound calls, encrypted SIP options, transfers, and batch calls are documented.[^4] | N | Treat carriers and voice runtime as replaceable delivery infrastructure. Voni owns contact authorization, case state, and reconciliation. |
| Messaging | WhatsApp supports text, voice notes, media, and inbound or outbound calling, subject to Meta permissions and templates.[^5] | N | Add channels only through a common case timeline and contact-policy gate. |
| Batch outreach | File upload, scheduling, testing, progress tracking, API control, and batch calling are native.[^4] | N | Voni's campaign screen should evolve into policy-governed case initiation, not compete as a dialer. |
| Workflow builder | Visual workflows support branching, subagents, conditions, agent transfer, phone transfer, tool overrides, and workflow analytics.[^6] | N | Do not rebuild general conversation graphs. Compile a resolution plan into provider workflows where useful. |
| Structured procedures | Ordered Ask, Tell, exact Say, Tool, conditional, retry, sub-procedure, and system-tool steps are native.[^7] | N | Use for session execution. Keep authoritative plan state, deadlines, and completion rules in Voni. |
| Tools | Client tools, webhooks, server-side code tools for enterprise customers, MCP tools, and system tools are supported.[^8] | N | Voni's advantage is policy-scoped tool authorization and durable receipts, not tool calling itself. |
| End-user confirmation | MCP tools can be configured as Always Ask, selectively approved, or unapproved.[^9] | N | Do not claim confirmation as unique. Extend it with identity, role, action risk, expiry, dual control, and case-linked evidence. |
| Knowledge base and RAG | Documents, URLs, text, and files can be supplied as full context or retrieved with RAG.[^10] | N | A knowledge base can contain policy text. It does not establish policy ownership, signed approval, effective dates, clause lineage, or permitted action semantics. |
| Dynamic personalization | Dynamic variables can personalize prompts, messages, tools, and conversation behavior.[^11] | N | Pass minimum necessary case context. Do not make provider variables the authoritative case store. |
| Connection authentication | Signed URLs and hostname allowlists protect access to private agents; the host application still authenticates the end user.[^12] | N | Voni must perform institution-specific identity proofing and bind the result to allowed actions. |
| Customer identity proofing | Identity providers and customer systems can be called through tools. No general managed proofing layer was evidenced. | C | Build pluggable verification policies with assurance levels, attempt limits, expiry, and evidence. Do not equate caller ID with identity. |
| Conversation users and history | External user IDs and conversation timelines are native.[^13] | N | Useful provider metadata. A conversation timeline is not a case with obligations, owners, deadlines, and cross-provider events. |
| Cross-session business state | Post-call webhooks expose transcript, analysis, metadata, tools, and version IDs. ElevenLabs' own example stores topics in the customer's database and passes them into the next call.[^14] | C | This is direct evidence that durable business state belongs outside the voice runtime. Voni should make it a managed case ledger. |
| Agent-performance triage tickets | Workspace and per-agent tickets support open, in-progress, resolved, and merged statuses, assignment, comments, and conversation links.[^3] | N | Acknowledge the feature. It is a QA queue for agent behavior, not an applicant's institutional case or approval queue. |
| End-user case management | CRM and support integrations can create or update external cases, tickets, contacts, and conversations.[^15] | C | Voni should coexist with the institution's system of record while owning governed orchestration, evidence, and reconciliation. Do not market a generic ticket system. |
| Human transfer | Transfers to numbers or agents are native, with conference, blind transfer, and SIP REFER options subject to telephony constraints.[^16] | N | Transfer is a channel event. Voni must package the case summary, verified facts, unresolved step, policy basis, and handoff receipt. |
| Human work queues for institutional decisions | External CRMs can receive work, and QA tickets handle agent issues. No first-party managed queue tied to policy authority, applicant deadlines, and decision evidence was evidenced. | U | Build exception, approval, dispute, vulnerability, integration-failure, and overdue queues as first-class case views. |
| Structured extraction | Post-call data collection extracts strings, numbers, booleans, or integers, and conversation analysis is available through APIs and webhooks.[^17] | N | Treat model extraction as a claim requiring source evidence and confidence, not as a verified case fact. |
| Success evaluation | Criteria-based post-call success evaluation is native.[^18] | N | Keep provider evaluations as one signal. Voni measures case resolution, policy conformance, human overrides, and evidence completeness. |
| Automated testing | Simulations, next-reply tests, tool-call tests, dashboard, CLI, API, and repeated probabilistic runs are documented.[^19] | N | Do not build a weaker generic test runner. Add signed policy conformance suites and cross-provider parity tests. |
| Experiments | Live traffic can be split across versioned variants with experiment analysis.[^20] | N | Prevent experiments from changing regulated wording or authority without policy approval. Experiment within approved bounds. |
| Versioning | Immutable agent configuration snapshots, branches, drafts, traffic splitting, merge, and rebase are native.[^21] | N | Agent configuration versioning is not policy sign-off. Voni must pin each case event to a signed policy version and reviewer record. |
| Guardrails | Guardrails 2.0 covers focus, manipulation, content, and custom rules on inputs and responses. The feature is labeled alpha, blocking adds latency, and streamed output can begin before a trigger.[^22] | N | Use provider guardrails as defense in depth. Enforce material permissions before execution in Voni's deterministic authority layer. |
| Conversation analytics | Dashboard analytics include call volume, cost, performance, success, collected data, language, active calls, and workflow-node metrics.[^23] | N | Voni's dashboard should lead with unresolved cases, time to resolution, policy exceptions, and audit completeness. |
| Search and monitoring | Keyword and semantic transcript search, active-call monitoring, analytics, and operational views are native.[^24] | N | Avoid rebuilding a generic call-observability suite. Link provider views from the case evidence record. |
| OpenTelemetry | Conversation traces can be exported to customer collectors through post-call, retrieval, and monitoring paths.[^25] | N | Accept trace references and health events through adapters. Keep case evidence independent of a provider's trace retention. |
| Workspace roles and sharing | Enterprise workspaces support administrative roles and resource-level viewer, editor, and admin access.[^26] | N | Do not claim basic workspace RBAC as unique. Add institution roles expressed against actions, case types, jurisdictions, and approval thresholds. |
| SSO and provisioning | Enterprise SAML or OIDC SSO and SCIM provisioning are supported.[^27] | N | Integrate rather than replace institutional identity governance. Preserve external identity and role evidence on approvals. |
| Administrative audit logs | Enterprise audit logs cover more than 100 administrative endpoints and use OCSF-formatted events.[^28] | N | Administrative logs remain valuable. Voni's separate ledger explains why a customer outcome changed and under which policy clause. |
| Retention and redaction | Conversation and audio retention controls are native. Enterprise redaction options are available.[^29] | N | Voni needs case-level retention schedules, legal holds, selective evidence preservation, and deletion propagation across providers. |
| Zero-retention mode | Enterprise zero-retention mode is available for eligible API traffic, with product-specific caveats; batch calling is incompatible.[^30] | N | Make feature compatibility visible before deployment. Do not promise zero retention across a multi-provider case without end-to-end verification. |
| Data residency | Isolated environments are documented for the US, EU, India, and Singapore. Storage is local, while some processing can occur elsewhere unless narrower conditions are met.[^31] | N | Residency is a deployment constraint in each policy pack and adapter. Voni must disclose the entire data path, not a provider region alone. |
| Private deployment | Enterprise private deployment on AWS and GCP can place the runtime in a customer's VPC and connect customer LLM, telephony, and retrieval services.[^32] | N | Infrastructure control is strong and should be supported. It still does not replace the institution's policy, authority, and case model. |
| Enterprise privacy and security | ElevenLabs documents enterprise privacy, security controls, encryption, workspace administration, and deployment options.[^29] | N | Security due diligence remains mandatory. Voni should never position itself by denying mature provider controls. |
| CRM and service integrations | HubSpot, Salesforce, Zendesk, Intercom, and Genesys integrations are documented, with different tool, trigger, attachment, and zero-retention limitations.[^15] | N | Reuse where appropriate. The source system keeps its record; Voni retains orchestration evidence and reconciles every side effect. |
| Public-sector and regulated-sector use cases | ElevenLabs publishes government, banking, insurance, and employment-service material. Some pages describe partnerships or planned rollouts; these are vendor claims, not independent proof of regulated case ownership.[^33] | N | Do not claim an empty vertical market. Sell a precise governed workflow with measurable institutional outcomes. |
| Pricing | Public self-service tiers and usage pricing exist, with enterprise terms negotiated separately. Agent pricing lists platform usage, telephony, and model-cost components.[^34] | N | Avoid competing on minutes. Price Voni for governed cases, controls, auditability, and implementation, with provider consumption passed through or contracted directly. |
| Signed institutional policy packs | No managed approval lifecycle tying reviewers, effective dates, clauses, wording, tests, actions, and cases was evidenced. | U | This should be a primary Voni object and deployment gate. |
| Clause-to-action evidence | Tools, transcripts, analysis, traces, and audit logs provide ingredients. No managed case ledger binding every material statement and execution to the governing clause was evidenced. | U | Build append-only evidence records with source and execution lineage. |
| Durable authority and dual control | User confirmation and workspace permissions exist, but no public managed model was evidenced for expiring case-specific authority, required approver sets, segregation of duties, or dual control. | X | This is a core Voni service. A provider may present a confirmation UI, but Voni decides whether execution is authorized. |
| Ownership of regulated decisions | ElevenLabs can supply conversation, workflow, and private runtime components. The institution remains accountable for its decisions and customer outcomes. | X | Voni must keep AI within bounded actions and route consequential judgment to an accountable institution actor. |

## Where ElevenLabs should remain in the product

ElevenLabs can remain a preferred voice provider when it meets an institution's language, latency, security, residency, commercial, and deployment requirements. Its workflows can execute a session-level plan, its tools can call Voni's APIs, and its webhooks and traces can feed the evidence ledger.

The integration boundary should be explicit:

| ElevenLabs may own | Voni must own |
| --- | --- |
| Speech recognition and synthesis | Case identity and lifecycle |
| Turn-taking and interruption | Contact authorization and jurisdiction rules |
| Session workflow execution | Signed policy version and effective-date selection |
| Session variables | Verified case facts and provenance |
| Provider-native tools and transfers | Action risk, approval, expiry, and dual control |
| Conversation recording and transcript | Cross-channel evidence index and retention policy |
| Session analysis and QA | Resolution completion criteria and institutional outcome |
| Agent configuration versions | Policy versions, reviewer signatures, and case pinning |
| Provider observability | Cross-provider reconciliation and audit export |

The winning criterion is simple: an institution should still need Voni after it has bought ElevenLabs. If removing Voni leaves the institution with the same case state, authority controls, evidence, and resolution operation, Voni has not created a defensible product.

## Current Voni foundation and required pivot

The current codebase contains useful foundations, but it does not yet implement the proposed regulated-case platform.

| Current capability | Evidence in the repository | Decision |
| --- | --- | --- |
| Organization context | Sessions resolve a user, organization, and membership role before scoped work.[^35] | **Keep and harden.** Add institution roles, case entitlements, approval groups, and service identities. |
| Agents | Agent configuration, provider deployment ID, version, and durable deployment status are persisted.[^36] | **Keep as a runtime asset.** Agents become deployable executors of approved resolution plans. |
| Campaigns | Campaigns carry agent, calling window, consent policy, fallback, status, attempts, and retry configuration.[^36] | **Refactor.** Campaigns become bulk case initiation and contact scheduling. Do not make dialer breadth the roadmap. |
| Leads | Leads are organization-scoped, phone-canonical records with consent and pipeline state.[^36] | **Evolve.** Introduce parties, verified contact points, preferences, relationships, and identity-assurance records. Avoid using a phone number as legal identity. |
| Calls, messages, and conversation state | Calls, transcripts, messages, blockers, next action, and memory summaries persist across interactions.[^36] | **Keep as interaction evidence.** Move authoritative progression into a case and resolution-plan model. |
| Tool-call logs | Tool input, result, errors, latency, and an external idempotency key are stored.[^36] | **Grow into evidence records.** Add policy clause, source fact, authority decision, execution receipt, and immutable lineage. |
| Durable jobs | Jobs are organization and creator scoped, idempotent, leased, retryable, cancellable, and retain sanitized state. Work is persisted before a caller returns 202.[^37] | **Keep and generalize.** All slow integrations, document checks, policy validation, exports, and reconciliation use this substrate. |
| Calling and consent controls | Calling windows are timezone aware, consent policies are configured, invalid conditions fail closed, and skip reasons are recorded.[^38] | **Keep as an early policy primitive.** Replace market assumptions with jurisdiction-versioned policy rules and proof of legal review. |
| Voice mutation confirmation | Proposals bind user, organization, route, target, expected version, immutable payload, readback, expiry, and independently observed assent. The model cannot self-authorize.[^39] | **Keep and promote to a server-side authority service.** Add role checks, identity assurance, action risk, approver quorum, dual control, and durable evidence. |
| Voice copilot | The signed-in product has navigation and operator tools with proposal gates for mutations; public and auth routes are intentionally outside tool-enabled access.[^40] | **Keep as one operator interface.** Voice never becomes a bypass around authorization, and public demos remain tool-free. |
| Provider coupling | Agents currently store AssemblyAI IDs, calls store AssemblyAI sessions, and telephony uses Telnyx control IDs.[^36] | **Abstract deliberately.** Introduce normalized provider contracts without pausing the lighthouse pilot for perfect portability. |

The product description currently centers agents, calls, campaigns, leads, and conversion.[^41] That remains a useful operational base. The new strategy changes the category and the product's proof point: Voni resolves governed cases and can use voice to do so.

## What should stop driving the roadmap

These capabilities may remain necessary, but they should not define differentiation:

- More generic agent-builder controls.
- A larger voice catalog.
- Another visual conversation workflow editor.
- Commodity SIP, transfer, recording, or batch-call features.
- Generic knowledge-base ingestion or RAG.
- Basic transcript analytics, summaries, or sentiment dashboards.
- A generic CRM, support ticketing system, or contact center replacement.
- Basic “ask before tool use” confirmation.
- Provider-specific agent configuration as the source of institutional policy.
- Usage-based voice resale as the primary revenue model.

Build only the portions required to express a governed case or to maintain a clean provider boundary. Buy or integrate the rest.

## Workflow selection

### Scoring method

Scores run from 1 to 5. For regulatory exposure, integration burden, procurement difficulty, data requirements, and competitive crowding, **5 is favorable**: lower exposure, easier integration, easier procurement, better data readiness, or more whitespace. Weighted totals are directional hypotheses, not market evidence.

| Criterion | Weight | Proactive Application Resolution | Governed Collections | Support Through Difficult Moments |
| --- | ---: | ---: | ---: | ---: |
| Urgency | 10 | 4 | 5 | 4 |
| Measurable value | 15 | 5 | 5 | 4 |
| Regulatory safety | 15 | 4 | 1 | 2 |
| Reversibility | 10 | 5 | 2 | 3 |
| Integration ease | 10 | 3 | 2 | 2 |
| Procurement ease | 10 | 3 | 1 | 2 |
| Data readiness | 5 | 3 | 3 | 2 |
| Competitive whitespace | 5 | 3 | 2 | 3 |
| Reuse across sectors | 10 | 5 | 4 | 4 |
| Pilot credibility | 10 | 5 | 2 | 2 |
| **Weighted total** | **100** | **83** | **55** | **57** |

### 1. Proactive application resolution

This workflow starts when the institution's source system identifies a narrow, correctable blocker. Examples include an expired identity-document copy, a missing proof of address, an unreadable page, or an unanswered factual field. Voni does not infer adverse status or decide whether the application should be accepted.

Why it leads:

- The trigger and successful outcome can be defined precisely.
- The applicant can correct or dispute the condition.
- The system can use approved exact wording and a secure existing document channel.
- Actions can remain informational or reversible.
- Human judgment retains eligibility, exceptions, fraud, sanctions, affordability, pricing, and final acceptance.
- Resolution time, repeat contacts, applicant completion, and staff effort are measurable.
- The same pattern applies to insurance applications, licenses, permits, benefits, claims intake, and other evidence-driven processes.

The main risk is integration. The pilot should therefore use one source-system event, one secure upload destination, one or two correctable requirement types, and one final source-system reconciliation.

### 2. Support through difficult moments

This includes bereavement, financial hardship, vulnerability, disaster, serious claims, and other emotionally difficult situations. It offers strong human value and cross-sector reuse, but ambiguity and harm are higher. Detecting vulnerability can itself create sensitive data. An apparently helpful autonomous response can become inappropriate advice, pressure, or an unrecorded exception.

This should become a human-assisted queue after the case, policy, evidence, and handoff model is proven. Early use can identify a signal, pause automation, preserve the customer's words, and route a structured handoff. It should not attempt to resolve the sensitive situation autonomously.

### 3. Governed collections

Collections has clear economic value and urgency, but it combines contact restrictions, disputes, vulnerability, payment authority, affordability, hardship treatment, and reputational risk. UAE standards, for example, require documented collection processes, reasonable communication, options for customers in difficulty, and records of contact and complaints.[^42]

The later entry point should be restricted to factual balance reminders, permitted-time contact, secure payment-channel directions, and hardship or dispute detection. Negotiating plans, making legal claims, applying fees, or threatening consequences should remain outside autonomous scope until authority and human-review evidence are mature.

## Lighthouse product: proactive application resolution

### Narrow pilot contract

**Institution:** one UAE-regulated retail financial-services organization.

**Process:** one application type already managed in an institutional source system.

**Trigger:** a source-system event states one approved, correctable requirement.

**Channels:** one outbound voice provider plus one secure digital follow-up channel.

**Languages:** two institution-approved languages with reviewed wording and parity tests.

**Volume:** a controlled cohort and a concurrent control group.

**Decision boundary:** Voni cannot approve, reject, price, score, waive a requirement, interpret suspicious activity, or accept evidence as valid.

### Case journey

1. The source system sends an idempotent `application.requirement_opened` event with a source reference, requirement code, and approved supporting facts.
2. Voni selects the policy-pack version effective for the institution, jurisdiction, case type, channel, and language. The version remains pinned to the case unless a controlled migration occurs.
3. A deterministic pre-contact gate checks purpose, channel, local time, consent or other lawful basis, suppression, frequency, recording rule, and active policy status.
4. The provider places the call. The approved introduction identifies the institution and purpose, makes required AI or recording disclosures, asks whether the time is convenient, and respects a stop request.[^43]
5. Identity is verified to the assurance level required for the information that will be disclosed. Failed or expired verification cannot be bypassed by the model.
6. The agent explains the exact outstanding requirement using approved wording. It can answer bounded procedural questions from the signed policy pack.
7. The applicant can confirm understanding, dispute the premise, request another language or channel, schedule a callback, or ask for a person.
8. Sensitive documents go to the institution's secure upload channel. The pilot does not collect document images through the voice provider.
9. Any change is proposed, read back, confirmed, authorized, and executed through Voni. The model cannot supply its own confirmation evidence.
10. A durable job reconciles the source system. A call ending, tab closing, worker restart, or provider timeout does not lose accepted work.
11. The case moves to a human queue for dispute, vulnerability, uncertain policy match, repeated identity failure, failed integration, overdue status, or any requested exception.
12. The case closes only after the source system reports the requirement resolved or an authorized human records another final disposition.

### Explicit non-goals for the pilot

- Creditworthiness, affordability, eligibility, pricing, underwriting, benefit entitlement, fraud, AML, sanctions, or adverse-action decisions.
- Legal advice or an explanation of why a regulated decision was made.
- Autonomous acceptance of a document as authentic or sufficient.
- Collection of card details, passwords, one-time passwords, or document images in voice transcripts.
- Cold acquisition, debt collection, upselling, or cross-selling.
- Replacing the institution's application system, document portal, CRM, complaints system, or contact center.
- A public tool-capable demo.

### Pilot metrics and guardrails

The primary outcome is **verified requirement resolution within the agreed service window**, not call completion.

| Measure | Definition | Initial decision rule |
| --- | --- | --- |
| Verified resolution rate | Cases the source system confirms as resolved, divided by eligible contacted cases. | Must improve against the control cohort without increasing complaints or invalid updates. |
| Median time to resolution | Time from accepted trigger to source-system confirmation. | Must fall materially against the institution baseline. |
| Repeat-contact rate | Additional contacts required after first meaningful engagement. | Should decline. |
| Staff minutes per resolved case | Human handling time across the full case. | Should decline without shifting hidden work to another queue. |
| Policy-conformant statement rate | Material agent statements matched to an active approved clause and language variant. | Target 100 percent; any unmatched material statement is a release blocker. |
| Evidence completeness | Closed cases with trigger, policy version, identity result, interactions, authority events, and final receipt. | Target 100 percent. |
| Unauthorized execution | Executions lacking required identity, confirmation, or approval. | Target zero; any occurrence pauses the pilot. |
| Language outcome parity | Resolution and escalation outcomes by approved language. | Investigate material disparities before increasing volume. |
| Human override and dispute rate | Cases corrected or contested by staff or applicants. | Review every event during pilot and use it to revise policy or scope. |
| Complaint and stop-request rate | Complaints and contact-stop requests attributable to the workflow. | Must not worsen against the baseline; stop requests apply immediately. |

Call automation metrics such as latency, containment, and transfer rate remain diagnostic. They are not the business outcome.

## Shared platform model

### Policy packs

A policy pack is the approved, deployable contract for one institution, jurisdiction, workflow, and effective period.

Minimum fields:

- Institution, jurisdiction, business line, case type, channels, and languages.
- Effective-from and effective-to timestamps, superseded version, and rollout scope.
- Source documents, clause references, content hashes, and legal or compliance review records.
- Approved exact wording, bounded paraphrase rules, prohibited claims, and required disclosures.
- Evidence schemas and the source systems allowed to assert each fact.
- Permitted actions, action risk, verification level, approver requirements, reversibility, expiry, and execution adapter.
- Contact windows, frequency, suppression, recording, consent or other legal-basis rules.
- Escalation conditions, human queue, service deadlines, and closure conditions.
- Test suite, evaluation thresholds, provider compatibility, and rollback target.
- Named policy owner, operations owner, reviewers, approvals, signatures, and timestamps.

Lifecycle:

```text
draft -> in_review -> approved -> scheduled -> active -> superseded -> retired
             \-> rejected
```

Only signed versions can become active. Editing creates a new version. Existing cases remain pinned unless an authorized migration explains the reason and records both versions.

### Cases

A case is the durable unit of work. It can span many interactions and systems without depending on one provider's conversation ID.

Minimum fields:

- Institution, case type, jurisdiction, source-system reference, and idempotency key.
- Parties and relationships, with contact points stored separately from verified identity.
- Pinned policy-pack version and resolution-plan version.
- Open requirements, deadlines, responsible team, and current disposition.
- Identity-assurance records and their permitted disclosure or action scope.
- Interaction references across voice, message, document, web, and human work.
- Proposed, confirmed, authorized, executed, failed, unknown, and reconciled actions.
- Evidence records, disputes, vulnerability signals, approvals, and human notes.
- Source-system state, reconciliation watermark, closure reason, and retention class.

Suggested lifecycle:

```text
initiated -> contact_pending -> engaged -> identity_pending -> resolution_in_progress
        -> awaiting_customer | awaiting_institution | approval_pending
        -> execution_pending -> resolved -> closed

Any active state may also become escalated, withdrawn, cancelled, or permission_blocked.
```

The state machine must distinguish an unknown execution result from a failed result. Retrying a timeout without reconciliation can duplicate a real-world side effect.

### Authority gates

An authority gate answers whether this specific actor may perform this specific action on this case now.

| Field | Purpose |
| --- | --- |
| Action type and risk | Separates informational, reversible, consequential, and prohibited operations. |
| Allowed actor | Customer, agent runtime, employee role, approver group, service identity, or named integration. |
| Identity assurance | Required verification method, level, freshness, attempts, and lockout. |
| Case prerequisites | Required facts, policy status, deadlines, dispute state, and source-system state. |
| Confirmation | Required readback, assent channel, exact payload hash, and expiry. |
| Approval | Required role, quorum, segregation of duties, and dual-control conditions. |
| Reversibility | Inverse operation, undo window, or explicit irreversible classification. |
| Execution | Adapter, idempotency scope, timeout, retry policy, and reconciliation method. |
| Evidence | Facts, clause, decision, confirmation, approval, request, response, and timestamps to retain. |

The universal mutation invariant is:

```text
propose -> read back -> confirm -> authorize -> execute -> record -> reconcile
```

“Confirm” captures the affected person's assent where appropriate. “Authorize” is the institution's policy decision. They are independent. Customer assent cannot grant an employee permission they do not have, and an employee's role cannot fabricate customer assent.

### Evidence records

Evidence records should be append-only and independently queryable. A material case event records:

- Source fact and provenance, including source version or event identifier.
- Governing policy-pack version and clause.
- Agent or employee statement, language, provider, and interaction reference.
- Proposed payload, readback, assent event, authorization decision, and approver identity.
- Tool request, idempotency key, execution result, external receipt, and reconciliation result.
- Model or extractor output with confidence and source span, clearly marked as inferred rather than verified.
- Timestamps, clock source, retention class, and integrity hash or tamper-evident chain reference.

The evidence system should store the minimum content required to reconstruct a material action. It should reference protected source documents rather than duplicate sensitive content by default.

### Resolution plans

A resolution plan combines deterministic obligations with bounded conversational flexibility.

- Deterministic: contact eligibility, identity requirements, exact disclosures, action prerequisites, approvals, deadlines, closure rules, and escalation triggers.
- Flexible: order of non-dependent explanations, tone within approved bounds, clarifying questions, interruption handling, and language-specific conversational phrasing.
- Forbidden: inventing requirements, changing the source-system decision, selecting an unapproved action, suppressing a dispute, or marking a case resolved without authoritative evidence.

Provider workflow graphs are compiled execution targets. The signed Voni resolution plan remains the source of truth.

### Human work queues

Queues are saved views over case obligations, not generic tickets. Initial queues:

- Applicant disputes the requirement or source facts.
- Vulnerability, hardship, bereavement, distress, accessibility need, or requested accommodation.
- Identity cannot be verified at the required assurance level.
- Policy match is absent, ambiguous, expired, or conflicts with another rule.
- An action requires approval or dual control.
- Integration failed, timed out, returned unknown, or disagrees with Voni's state.
- Case is overdue or repeated contact has reached its limit.
- Language confidence or outcome parity falls below the approved threshold.

Each queue item opens the whole case with a concise handoff: what happened, what is verified, what remains unresolved, which policy applies, which action is requested, and what deadline or risk matters.

### Provider adapters

The adapter contract should normalize capabilities and events without pretending providers are identical.

```text
Provider profile
  speech input/output languages, locale quality, latency, residency, retention
  telephony and messaging channels, transfer modes, recording behavior
  interruption, turn events, tool semantics, workflow support, guardrails
  transcript format, confidence, timestamps, trace links, quality metrics
  private deployment, outage state, quotas, and feature incompatibilities

Normalized interaction events
  session.started | participant.verified | turn.started | turn.finalized
  interruption.detected | disclosure.delivered | tool.requested
  transfer.requested | transfer.completed | session.ended
  transcript.available | recording.available | analysis.available
  provider.degraded | delivery.failed
```

Provider-specific data remains accessible through namespaced metadata. Voni should not force a lossy lowest-common-denominator model for audits.

### Institution controls

- Tenant isolation at storage, authorization, queue, and export boundaries.
- SSO integration and role mapping, with service identities separated from people.
- Case-type and action-level permissions, approval groups, and segregation of duties.
- Retention, legal hold, redaction, deletion propagation, and residency policies.
- Environment promotion, signed policy deployment, canary scope, rollback, and kill switch.
- Cross-provider test suites, language parity checks, quality thresholds, and incident controls.
- Audit export that can reconstruct a case without requiring provider dashboard access.

## Product interfaces

### Policy studio

```text
┌ Policy pack: UAE retail application resolution v7 ────────────────┐
│ Status: In review     Effective: 01 Oct 2026     Jurisdiction: UAE │
├───────────────────────┬────────────────────────────────────────────┤
│ 1 Scope               │ Clause 4.2: Expired identity copy          │
│ 2 Sources             │ Source: Customer onboarding policy 2026-3 │
│ 3 Approved wording    │ Arabic ✓  English ✓                        │
│ 4 Actions             │ Explain, send secure link, schedule call   │
│ 5 Authority           │ Cannot waive, accept, approve, or reject   │
│ 6 Escalation          │ Dispute, vulnerability, failed identity    │
│ 7 Tests               │ 42 passed   2 need review                  │
│ 8 Review              │                                            │
├───────────────────────┴────────────────────────────────────────────┤
│ Reviewers: Compliance approved · Operations pending               │
│ [Compare with v6] [Request changes] [Approve with signature]      │
└────────────────────────────────────────────────────────────────────┘
```

The interface starts from source clauses and allowed outcomes. Provider prompts and workflows appear as generated deployment artifacts, not the primary authoring model.

### Case and exception workspace

```text
┌ Case PAR-… · Missing proof of address · Due in 18h ───────────────┐
│ Awaiting institution · Identity verified for requirement details  │
├──────────────────────────┬─────────────────────────────────────────┤
│ Resolution plan          │ Evidence                                │
│ ✓ Contact permitted      │ Trigger: onboarding event received      │
│ ✓ Required disclosure    │ Policy: UAE application pack v7 §4.2   │
│ ✓ Secure link delivered  │ Call: English · provider trace linked   │
│ ! Applicant disputes age │ Statement and source fact differ        │
│ ○ Specialist review      │ No update executed                      │
│ ○ Source reconciliation  │                                         │
├──────────────────────────┴─────────────────────────────────────────┤
│ Recommended next step: verify source date with onboarding system  │
│ [Open source record] [Request clarification] [Escalate]           │
└────────────────────────────────────────────────────────────────────┘
```

The default view explains the unresolved obligation and decision boundary. Raw transcripts and provider logs remain secondary evidence.

### Deployment and provider control

```text
┌ Deployment: Application resolution v7 ────────────────────────────┐
│ UAE production · 5% cohort · kill switch ready                    │
├──────────────┬───────────┬──────────┬────────────┬─────────────────┤
│ Provider     │ Languages │ Residency│ Test suite │ Health          │
│ ElevenLabs   │ ar, en    │ approved │ 118 / 118  │ healthy         │
│ AssemblyAI   │ en        │ review   │ 104 / 118  │ pilot only      │
│ Human queue  │ ar, en    │ UAE      │ ready      │ 3 specialists   │
├──────────────┴───────────┴──────────┴────────────┴─────────────────┤
│ Policy signature valid · CRM reconciliation healthy · 0 unknowns  │
│ [Pause new cases] [Rollback to v6] [Open exceptions]              │
└────────────────────────────────────────────────────────────────────┘
```

The provider is visible because its limitations matter. It is not the deployment's organizing object.

## Service and API boundaries

These are product contracts, not an instruction to implement every endpoint before the pilot.

### Policy APIs

| Operation | Contract |
| --- | --- |
| `POST /api/policy-packs` | Create a draft in the caller's institution. |
| `POST /api/policy-packs/{pack}/versions` | Create a new immutable-intent draft from a source version. |
| `POST /api/policy-versions/{version}/validate` | Return `202` with a durable validation job and idempotency key. |
| `POST /api/policy-versions/{version}/submit-review` | Freeze content, record requested reviewer groups, and begin review. |
| `POST /api/policy-versions/{version}/approvals` | Record an authenticated approval or rejection with content hash and role. |
| `POST /api/policy-versions/{version}/publish` | Return `202`; verify signatures, tests, effective date, provider compatibility, and environment before activation. |
| `POST /api/policy-versions/{version}/retire` | Stop new case selection while preserving historical evidence. |

### Case and action APIs

| Operation | Contract |
| --- | --- |
| `POST /api/cases` | Idempotently accept a validated source trigger and pin the effective policy version. |
| `POST /api/cases/{case}/contacts` | Request a contact attempt only after deterministic policy evaluation. Slow work returns `202` with a job. |
| `POST /api/cases/{case}/identity-checks` | Begin or record a proofing result from an approved adapter and assurance policy. |
| `POST /api/cases/{case}/action-proposals` | Bind exact payload, expected resource version, policy clause, risk, inverse operation, and expiry. |
| `POST /api/action-proposals/{proposal}/readbacks` | Record the exact finalized readback event and provider evidence. |
| `POST /api/action-proposals/{proposal}/confirmations` | Record independently observed assent for the bound payload. |
| `POST /api/action-proposals/{proposal}/authorizations` | Evaluate deterministic rules and collect human approvals if required. |
| `POST /api/action-proposals/{proposal}/execute` | Return `202`; execute idempotently and reconcile unknown results before retry. |
| `POST /api/cases/{case}/escalations` | Create a durable obligation in the correct human queue with a deadline. |
| `POST /api/cases/{case}/close` | Close only when resolution evidence satisfies the plan or an authorized human provides a disposition. |
| `GET /api/cases/{case}/evidence` | Return an authorized, ordered reconstruction with provider and source references. |

Mutating requests require an `Idempotency-Key`. State-dependent requests require an `If-Match` or equivalent expected version. Public or model-facing tools use scoped opaque references; they never accept guessed database identifiers or provider control IDs.

### Example action envelope

```json
{
  "case_ref": "opaque-case-reference",
  "action": "send_secure_upload_link",
  "payload": {
    "destination_ref": "verified-contact-reference",
    "template_ref": "approved-template-reference"
  },
  "expected_case_version": 12,
  "policy": {
    "version_ref": "signed-policy-version-reference",
    "clause_ref": "application.requirement.followup"
  },
  "evidence_refs": ["source-requirement-event-reference"],
  "expires_at": "2026-09-13T17:00:00Z"
}
```

The envelope contains references rather than sensitive source values. The server resolves and reauthorizes every reference at execution time.

## Responsive async behavior

The existing durable-job system is a strong foundation. The regulated-case extension should answer the repository's seven async questions as follows:

1. **Can it exceed three seconds?** Yes for policy validation, deployment, source sync, document status checks, exports, test suites, and provider operations. Persist and acknowledge these with `202` and a job ID.
2. **Does it require continuous interaction?** Live calls remain foreground sessions with continuous connection, transfer, recording, and recovery status. Accepted case work is still recorded durably.
3. **What survives when the page disappears?** Case state, action state, job state, idempotency key, lease, evidence, and reconciliation checkpoint.
4. **Where is status visible?** In the global jobs indicator, the case timeline, the responsible queue, and the deployment control surface.
5. **Where does the result open?** Policy jobs open the policy version, action jobs open the case evidence event, and deployment jobs open the deployment record.
6. **How do failure, retry, and duplicates work?** Typed failures, sanitized messages, explicit retry policy, cancellation where safe, unique idempotency scope, and reconciliation before retrying unknown side effects.
7. **Who may see it?** The institution boundary applies first. Creator-only remains the default for personal operations; case work uses explicit team assignment and role permissions when coordination is required.

## Operating model

### Recommended initial model: Voni-managed configuration with institution approval

Pure self-service is too risky before Voni has repeated policy patterns and validation evidence. A fully Voni-owned managed service is also inappropriate because Voni cannot approve an institution's policy or make its customer decisions.

For the first pilots:

| Party | Owns |
| --- | --- |
| Institution policy owner | Authoritative source policy, intended interpretation, approved wording, legal basis, effective dates, and final sign-off. |
| Institution operations owner | Current process, source-system rules, service levels, queues, staffing, escalation, and outcome baseline. |
| Institution compliance or legal reviewer | Jurisdictional review, approval or rejection, and conditions for launch. |
| Institution security and privacy owners | Data classification, identity, access, retention, residency, incident, and provider acceptance. |
| Voni implementation team | Structured policy-pack drafting, workflow configuration, adapter setup, deterministic tests, evidence mapping, training, and pilot monitoring. |
| Integration partner or institution technology team | Source-system integration, secure network access, identity-provider integration, and local change management. |
| Voice and infrastructure providers | Contracted runtime capabilities, service levels, security evidence, and technical event delivery. |

Voni may prepare a policy version. Only an authorized institution reviewer can approve it. Voni may recommend an action design. Only the institution defines the authority rule and owns the customer outcome.

After three to five repeated deployments of the same case pattern, introduce self-service authoring for trained institution teams. Partner-led configuration should follow a certification model with Voni validation and institution approval, not unrestricted prompt editing in production.

### Commercial model hypothesis

Charge for the value Voni owns:

- Annual platform and control-plane fee by environment and institution scope.
- Governed active-case volume or resolved-case volume, with clear treatment of reopened cases.
- Implementation and policy-pack setup for the initial workflow.
- Optional regulated language review, provider qualification, evaluation, and audit-export packages.
- Voice, telephony, model, and third-party verification usage passed through transparently or contracted directly by the institution.

Do not make margin on voice minutes the core model. That invites direct comparison with provider pricing and weakens provider neutrality.

## Regulatory portability

The product should encode representative control patterns without claiming universal compliance. Every deployment still requires local legal, compliance, privacy, employment, accessibility, telecommunications, and sector review.

| Pattern | Representative source | Product response | Boundary |
| --- | --- | --- | --- |
| UAE financial consumer treatment | CBUAE standards address fair treatment, documented debt collection, vulnerable consumers, complaint handling, records, and consumer data controls.[^42] | Signed policy packs, contact rules, vulnerability escalation, case records, responsible owner, deadline, reasoned human disposition, and retention. | CBUAE obligations vary by activity and regulated entity. The policy pack is evidence of an approved implementation, not a compliance certificate. |
| UAE complaints | Updated CBUAE complaint rules require accessible processes, acknowledgements and references, reasons, redress and escalation information, monitoring, and record retention.[^44] | Complaints become a dedicated case type. The lighthouse routes complaints out rather than attempting to absorb them as ordinary application questions. | Complaint independence and final response remain institutional responsibilities. |
| UAE telemarketing and recording | Official rules set calling-hour, identity, purpose, convenience, consent, frequency, recording, and stop-request controls for covered calls.[^43] | Jurisdiction-versioned contact gates, exact disclosures, recording state, suppression, frequency counters, convenient-time handling, and stored reasons for every blocked contact. | Marketing rules may not classify every service call the same way. Legal review determines applicability and lawful basis. |
| UAE personal data | The UAE data-protection framework and CBUAE standards establish consent, purpose, security, sharing, and retention obligations for covered processing.[^45] | Data minimization, source references, field-level classification, provider routing, retention schedules, deletion propagation, and documented legal basis. | Consent is one possible basis, not a universal substitute for legal analysis. Sector and free-zone rules may also apply. |
| EU AI governance | The EU AI Act treats some creditworthiness and access-to-essential-service uses as high risk and requires controls such as documentation, logging, human oversight, and quality management. Transparency duties also apply to some interactions.[^46] | Explicit AI disclosure rules, risk classification, human decision boundaries, signed versions, logs, monitoring, testing, and incident controls. Exclude credit decisions from the pilot. | Classification depends on the actual use, deployer, geography, and decision effect. |
| EU data protection | GDPR principles include lawfulness, purpose limitation, minimization, accuracy, security, accountability, records, and safeguards around solely automated significant decisions.[^47] | Purpose-bound case schemas, source provenance, correction and dispute flows, retention, access controls, meaningful human review, and evidence for explanations. | Voni cannot infer a lawful basis or rely on a superficial human approval to avoid automated-decision duties. |
| UK consumer outcomes and vulnerability | The FCA Consumer Duty focuses on good retail-customer outcomes, while FCA guidance expects firms to understand vulnerability, adapt service, and monitor outcomes.[^48] | Vulnerability signal routes, accommodation preferences, channel choice, human handoff, outcome monitoring, and cohort analysis. | Automated detection remains a signal. It must not become an adverse label or reduce service. |
| Canadian public-sector automated decisions | Canada's Directive on Automated Decision-Making requires impact assessment, notice, explanation, testing, monitoring, recourse, and levels of human intervention for covered federal administrative decisions.[^49] | Impact-assessment linkage, versioned notices, explanation evidence, approval thresholds, monitoring, recourse cases, and release gates. | This directive is not a global public-sector standard and does not cover every Canadian organization. |
| US AI-generated calls | The FCC has stated that AI-generated voices fall within the TCPA's artificial or prerecorded voice restrictions, making consent and disclosure analysis material.[^50] | Channel and jurisdiction contact gates, consent evidence, disclosure scripts, suppression, and provider-specific call metadata. | Federal and state requirements vary by call purpose, recipient, and geography. Counsel must approve outreach policy. |
| Accessibility | The European Accessibility Act covers certain products and services, including consumer banking and electronic communications. WCAG 2.2 supplies testable web accessibility guidance.[^51] | Voice plus accessible web and text alternatives, language and pace controls, transcript access where permitted, keyboard and screen-reader support, accommodation routing, and tested parity. | Voice is not automatically accessible. Recording, transcript, and identity methods can create new barriers. |
| AI risk management | NIST AI RMF is voluntary and organizes work around Govern, Map, Measure, and Manage. ISO/IEC 42001 defines an AI management-system standard.[^52] | Risk register, use-case inventory, ownership, evaluation, monitoring, change control, incident response, and evidence export. | Framework alignment is useful; certification or conformity must never be claimed without a formal assessment. |

### Policy portability principle

Do not encode “global consent,” “global recording disclosure,” or “global safe calling hours” as booleans. Encode a reviewed rule with jurisdiction, scope, effective dates, source citation, applicable channel and purpose, exact required behavior, reviewer, and test. When rules conflict or cannot be selected deterministically, block contact and route review.

## Delivery sequence

### Phase 0: discovery and proof design, 4 to 6 weeks

- Secure one design partner and obtain the real process map, policies, event samples, baseline volumes, outcomes, complaint data, and exception reasons.
- Select one correctable requirement with enough volume and little judgment.
- Complete legal, privacy, security, accessibility, and provider reviews.
- Define the authority matrix, human queues, service levels, stop conditions, control cohort, and success measures.
- Prototype the policy studio and case reconstruction with actual institution users before committing the schema.

**Gate:** the institution agrees that Voni will own governed orchestration and evidence for the pilot, rather than serving only as a voice front end.

### Phase 1: controlled lighthouse, 8 to 12 weeks

- Add policy packs, signed versions, source clauses, actions, and validation tests.
- Add cases, requirements, parties, identity evidence, resolution-plan state, and append-only events.
- Extend the proposal gate into server-side authority and durable execution.
- Build one source-system trigger, one secure-link action, one reconciliation adapter, and one provider adapter.
- Build the specialist exception queue and complete case evidence view.
- Run simulation, replay, negative, multilingual, failure, reconnect, duplicate, and provider-degradation tests.
- Launch to staff-assisted shadow mode, then a small customer cohort with a kill switch.

**Gate:** zero unauthorized executions; complete evidence for every closed case; material improvement in verified resolution time; no worsening of complaint or stop-request outcomes.

### Phase 2: harden and repeat, 3 to 6 months

- Add a second provider to prove adapter and evaluation portability.
- Add policy migration, environment promotion, rollback, retention, legal hold, redaction, and audit export.
- Add institution teams, case assignments, approval groups, dual control, and service identities.
- Add a second requirement type and a second language only after parity evidence.
- Integrate the institution's human queue or provide Voni queue APIs when replacement is not desired.

**Gate:** provider change does not change case semantics, authority, or historical reconstruction; the second deployment reuses most of the domain and control layer.

### Phase 3: adjacent case patterns, 6 to 12 months

- Expand Proactive Application Resolution into insurance, permits, licenses, benefits, or claims intake.
- Add human-assisted Support Through Difficult Moments for signal detection and governed handoff.
- Pilot informational collections only after a dedicated legal and conduct review.
- Open certified partner-led policy configuration after repeated validation.

## Build, buy, and integrate decisions

| Capability | Decision | Reason |
| --- | --- | --- |
| Voice runtime, speech, and base turn-taking | Buy from qualified providers | Mature, competitive horizontal layer. |
| Telephony and messaging transport | Buy | Commodity infrastructure with jurisdiction and reliability constraints. |
| General conversation workflow editor | Buy or compile to provider | Native offerings are already strong. |
| Generic KB and RAG | Buy | Differentiation is approved clause semantics and evidence, not retrieval plumbing. |
| Identity proofing | Integrate | Institutions need approved local methods and assurance levels. |
| CRM, core banking, claims, benefits, or permit systems | Integrate | These remain authoritative systems of record. |
| Case orchestration and resolution plan | Build | Central product object and cross-provider continuity. |
| Policy pack and approval lifecycle | Build | Primary governance boundary. |
| Authority service and dual control | Build | Determines whether action is permitted. |
| Evidence ledger and reconciliation | Build | Provides institutional reconstruction and safe retry. |
| Human case queues and handoff package | Build, with outbound integration | Needed for the case model, but institutions may keep their existing work-management UI. |
| Provider adapter and parity evaluation | Build | Protects case semantics and commercial choice. |
| Generic observability and tracing | Integrate | Provider and OpenTelemetry tools already exist. Voni adds case correlation. |

## Strategic risks and disconfirming evidence

| Risk | What would disconfirm the thesis | Response |
| --- | --- | --- |
| Existing case platforms absorb the layer | Design partners prefer their CRM or core platform to own policy, authority, evidence, and orchestration, and only want voice integration. | Offer a thin control plane only if it still owns meaningful authority and evidence. Otherwise do not enter that account with this product thesis. |
| ElevenLabs product expansion | ElevenLabs releases first-party regulated cases with signed policy approval, case-specific authority, evidence lineage, and cross-system reconciliation. | Maintain multi-provider and cross-channel scope, deepen institutional operating workflows, and reassess build areas quarterly. |
| Policy authoring is services-heavy | Each institution requires bespoke interpretation with little reusable structure. | Constrain the workflow, measure reuse, template only repeated patterns, and price implementation honestly. |
| Integration dominates value | Source systems cannot expose reliable triggers or reconciliation, or procurement blocks access. | Select the lighthouse partly on event and API readiness. Never hide manual reconciliation as automation. |
| Human queues become the bottleneck | Automation creates more exceptions or lower-quality work. | Track queue arrival, handle time, rework, and aging from the first shadow run. Tighten eligibility rather than increase volume. |
| Multilingual parity fails | Resolution, escalation, or complaint outcomes diverge materially by language. | Pause expansion, use reviewed language packs, test understanding, and retain a human path in the requested language. |
| Evidence costs exceed value | Complete reconstruction creates excessive storage, review, or latency. | Retain references and hashes where possible, tier evidence by materiality, and validate audit needs with real reviewers. |
| Provider abstraction becomes lowest-common-denominator | Portability removes useful native capabilities or hides safety differences. | Keep capability profiles and namespaced evidence. Certify workflow-provider combinations rather than claim universal interchangeability. |
| Regulated decision scope creeps | Teams ask the agent to waive, approve, score, negotiate, or make adverse decisions to improve containment. | Make prohibited actions structural, require signed scope changes, and treat unauthorized execution as a pilot stop event. |

## Research and validation backlog

Before product build begins, answer these with institution evidence:

1. Which application requirements create the largest correctable delay without requiring judgment?
2. Can the source system emit a trusted trigger and a later authoritative resolution receipt?
3. What information may be disclosed before each identity-assurance level?
4. Which calls count as service, marketing, or another category in the launch jurisdiction?
5. What recording, AI disclosure, consent, suppression, and contact-frequency rules apply to the exact workflow?
6. Which policy phrases must be exact, which may be paraphrased, and who signs each language version?
7. What makes a requirement disputed, vulnerable, urgent, or unsuitable for automation?
8. Who may approve each action, and which actions require two people or segregation of duties?
9. Which system is authoritative when Voni and the source system disagree?
10. What evidence do compliance, complaints, audit, privacy, and operational reviewers actually need?
11. What are the baseline resolution time, repeat contact, staff effort, complaint, abandonment, and language outcomes?
12. Will the institution adopt Voni's case workspace, consume it through APIs, or require all human work in an existing system?
13. Which provider deployment, retention, residency, and zero-retention combinations are contractually acceptable?
14. What pilot result would cause the institution to expand, pause, or terminate the product?

## Final positioning

**Category:** Governed case resolution.

**Positioning statement:**

> Voni is the governed case-resolution platform for regulated organizations. It turns approved policy into auditable, multilingual work that AI agents, employees, and external systems can advance safely over time.

**Proof, not slogan:**

- Every material case step cites an active approved policy clause.
- Every consequential action has the required identity, confirmation, authority, and execution evidence.
- Every accepted long-running operation survives the page, session, and provider connection.
- Every exception has a responsible queue, reason, deadline, and human decision boundary.
- Every case remains reconstructable after a provider is changed.
- The institution measures verified resolution and customer outcomes, not call volume alone.

**Short competitive answer:**

> ElevenLabs can run an excellent conversation. Voni governs the institutional case that the conversation is allowed to advance.

## Sources

### ElevenLabs product and administration

[^1]: ElevenLabs, [ElevenAgents overview](https://elevenlabs.io/docs/eleven-agents/overview), accessed 13 September 2026.
[^2]: ElevenLabs, [Agent workflows](https://elevenlabs.io/docs/eleven-agents/customization/agent-workflows), [structured procedures](https://elevenlabs.io/docs/eleven-agents/customization/procedures/structured-procedures), [MCP tool approvals](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp), [testing](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing), [versioning](https://elevenlabs.io/docs/eleven-agents/operate/versioning), and [private deployment](https://elevenlabs.io/docs/overview/capabilities/private-deployment), accessed 13 September 2026.
[^3]: ElevenLabs, [List agent conversation tickets](https://elevenlabs.io/docs/eleven-agents/api-reference/triage-tickets/list), [list workspace tickets](https://elevenlabs.io/docs/eleven-agents/api-reference/triage-tickets/list-for-workspace), and [create conversation ticket](https://elevenlabs.io/docs/eleven-agents/api-reference/triage-tickets/create), accessed 13 September 2026. The first source explicitly says these tickets concern the agent's performance, not end-user tickets.
[^4]: ElevenLabs, [SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking), [batch calls](https://elevenlabs.io/docs/eleven-agents/phone-numbers/batch-calls), and [transfer to number](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-number), accessed 13 September 2026.
[^5]: ElevenLabs, [WhatsApp](https://elevenlabs.io/docs/eleven-agents/whatsapp), accessed 13 September 2026.
[^6]: ElevenLabs, [Agent workflows](https://elevenlabs.io/docs/eleven-agents/customization/agent-workflows), accessed 13 September 2026.
[^7]: ElevenLabs, [Structured procedures](https://elevenlabs.io/docs/eleven-agents/customization/procedures/structured-procedures), accessed 13 September 2026.
[^8]: ElevenLabs, [Tools](https://elevenlabs.io/docs/eleven-agents/customization/tools), accessed 13 September 2026.
[^9]: ElevenLabs, [MCP server tool configurations](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp), accessed 13 September 2026.
[^10]: ElevenLabs, [Knowledge base](https://elevenlabs.io/docs/eleven-agents/customization/knowledge-base), accessed 13 September 2026.
[^11]: ElevenLabs, [Dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables), accessed 13 September 2026.
[^12]: ElevenLabs, [Agent authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication), accessed 13 September 2026.
[^13]: ElevenLabs, [Users](https://elevenlabs.io/docs/eleven-agents/operate/users), accessed 13 September 2026.
[^14]: ElevenLabs, [Post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks), accessed 13 September 2026.
[^15]: ElevenLabs, [HubSpot](https://elevenlabs.io/docs/eleven-agents/customization/integrations/hubspot), [Salesforce](https://elevenlabs.io/docs/eleven-agents/customization/integrations/salesforce), [Zendesk](https://elevenlabs.io/docs/eleven-agents/customization/integrations/zendesk), [Intercom](https://elevenlabs.io/docs/eleven-agents/customization/integrations/intercom), and [Genesys](https://elevenlabs.io/docs/eleven-agents/customization/integrations/genesys), accessed 13 September 2026.
[^16]: ElevenLabs, [Transfer to number](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-number), accessed 13 September 2026.
[^17]: ElevenLabs, [Data collection](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/data-collection), accessed 13 September 2026.
[^18]: ElevenLabs, [Success evaluation](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/success-evaluation), accessed 13 September 2026.
[^19]: ElevenLabs, [Agent testing](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing), accessed 13 September 2026.
[^20]: ElevenLabs, [Experiments](https://elevenlabs.io/docs/eleven-agents/operate/experiments), accessed 13 September 2026.
[^21]: ElevenLabs, [Versioning](https://elevenlabs.io/docs/eleven-agents/operate/versioning), accessed 13 September 2026.
[^22]: ElevenLabs, [Guardrails](https://elevenlabs.io/docs/eleven-agents/best-practices/guardrails), accessed 13 September 2026.
[^23]: ElevenLabs, [Analytics dashboard](https://elevenlabs.io/docs/eleven-agents/dashboard), accessed 13 September 2026.
[^24]: ElevenLabs, [Operate](https://elevenlabs.io/docs/eleven-agents/operate/overview) and [Smart search](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/smart-search), accessed 13 September 2026.
[^25]: ElevenLabs, [OpenTelemetry traces](https://elevenlabs.io/docs/eleven-agents/customization/opentelemetry-traces), accessed 13 September 2026.
[^26]: ElevenLabs, [Workspace members](https://elevenlabs.io/docs/overview/administration/workspaces/members) and [sharing resources](https://elevenlabs.io/docs/overview/administration/workspaces/sharing-resources), accessed 13 September 2026.
[^27]: ElevenLabs, [Single sign-on](https://elevenlabs.io/docs/overview/administration/workspaces/sso), accessed 13 September 2026.
[^28]: ElevenLabs, [Audit logs](https://elevenlabs.io/docs/overview/administration/workspaces/audit-logs), accessed 13 September 2026.
[^29]: ElevenLabs, [Privacy](https://elevenlabs.io/docs/eleven-agents/customization/privacy), accessed 13 September 2026.
[^30]: ElevenLabs, [Zero-retention mode](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode) and [batch calls](https://elevenlabs.io/docs/eleven-agents/phone-numbers/batch-calls), accessed 13 September 2026.
[^31]: ElevenLabs, [Data residency](https://elevenlabs.io/docs/overview/administration/data-residency), accessed 13 September 2026.
[^32]: ElevenLabs, [Private deployment](https://elevenlabs.io/docs/overview/capabilities/private-deployment), accessed 13 September 2026.
[^33]: ElevenLabs, [ElevenLabs for Government](https://elevenlabs.io/blog/introducing-elevenlabs-for-government), [Customers Bank partnership](https://elevenlabs.io/blog/customers-bank-partnership), [Ukraine employment services case study](https://elevenlabs.io/blog/ukraines-employment-services), [conversational AI in insurance](https://elevenlabs.io/blog/conversational-ai-in-insurance), and [government agents](https://elevenlabs.io/agents/government), accessed 13 September 2026. These are first-party vendor materials and should be read as product or customer claims.
[^34]: ElevenLabs, [Agents pricing](https://elevenlabs.io/pricing/agents), accessed 13 September 2026. Prices and packaging are time-sensitive and should be rechecked before commercial decisions.

### Voni repository evidence

[^35]: Voni source, [`src/lib/session.ts`](../src/lib/session.ts), reviewed 13 September 2026.
[^36]: Voni source, [`src/lib/db/schema.ts`](../src/lib/db/schema.ts), reviewed 13 September 2026.
[^37]: Voni source, [`src/lib/jobs/start.ts`](../src/lib/jobs/start.ts) and the background-jobs schema in [`src/lib/db/schema.ts`](../src/lib/db/schema.ts), reviewed 13 September 2026.
[^38]: Voni source, [`src/lib/campaigns/policy.ts`](../src/lib/campaigns/policy.ts), reviewed 13 September 2026.
[^39]: Voni source, [`src/lib/copilot/proposals.ts`](../src/lib/copilot/proposals.ts) and [`src/lib/copilot/bus.ts`](../src/lib/copilot/bus.ts), reviewed 13 September 2026.
[^40]: Voni, [`docs/copilot-coverage.md`](./copilot-coverage.md), reviewed 13 September 2026. This strategy relies on its scope and control design, not on historical test counts as current proof.
[^41]: Voni, [`PRODUCT.md`](../../PRODUCT.md), reviewed 13 September 2026.

### Regulatory and governance sources

[^42]: Central Bank of the UAE, [Consumer Protection Standards](https://rulebook.centralbank.ae/en/rulebook/consumer-protection-standards), including debt collection, vulnerable consumers, complaint, data, and recordkeeping requirements, accessed 13 September 2026.
[^43]: Central Bank of the UAE, [Telemarketing controls](https://rulebook.centralbank.ae/en/rulebook/part-2-telemarketing-controls) and UAE Legislation, [Cabinet Resolution No. 56 of 2024 concerning telemarketing regulations](https://uaelegislation.gov.ae/en/legislations/2519), accessed 13 September 2026.
[^44]: Central Bank of the UAE, [Complaint management and resolution](https://rulebook.centralbank.ae/en/rulebook/article-6-complaint-management-and-resolution) and [Consumer Protection Standards Article 8](https://rulebook.centralbank.ae/en/rulebook/article-8-complaint-management-and-complaint-resolution), accessed 13 September 2026.
[^45]: UAE Government, [Data protection laws](https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws), and Central Bank of the UAE, [Protection of consumer data and assets](https://rulebook.centralbank.ae/en/rulebook/article-6-protection-consumer-data-and-assets), accessed 13 September 2026.
[^46]: European Commission, [AI Act regulatory framework](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai), and European Union, [Regulation (EU) 2024/1689](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689), accessed 13 September 2026.
[^47]: European Union, [General Data Protection Regulation](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679), especially Articles 5, 22, and 30, accessed 13 September 2026.
[^48]: UK Financial Conduct Authority, [Consumer Duty information for firms](https://www.fca.org.uk/firms/consumer-duty/information-firms) and [good and poor practice for vulnerable customers](https://www.fca.org.uk/publications/good-and-poor-practice/delivering-vulnerable-customers), accessed 13 September 2026.
[^49]: Treasury Board of Canada Secretariat, [Directive on Automated Decision-Making](https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32592), accessed 13 September 2026.
[^50]: US Federal Communications Commission, [FCC makes AI-generated voices in robocalls illegal](https://docs.fcc.gov/public/attachments/DOC-400393A1.pdf), 8 February 2024, accessed 13 September 2026.
[^51]: European Union, [Directive (EU) 2019/882 on accessibility requirements for products and services](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32019L0882), and W3C, [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/), accessed 13 September 2026.
[^52]: National Institute of Standards and Technology, [AI Risk Management Framework](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10), and ISO, [ISO/IEC 42001:2023](https://www.iso.org/standard/42001), accessed 13 September 2026.
