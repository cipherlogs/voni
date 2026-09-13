export type CapabilityClass = "Native" | "Customer-built" | "Not managed" | "Needs Voni";

export type Capability = {
  area: string;
  elevenLabs: string;
  classification: CapabilityClass;
  voniDecision: string;
};

export const capabilityLegend: Array<{
  label: CapabilityClass;
  meaning: string;
}> = [
  { label: "Native", meaning: "Released or documented as an ElevenLabs product capability." },
  { label: "Customer-built", meaning: "Possible through tools, webhooks, or the institution's own systems." },
  { label: "Not managed", meaning: "No first-party managed product was evidenced in the reviewed documentation." },
  { label: "Needs Voni", meaning: "A voice provider may participate, but should not own the regulated obligation or decision." },
];

export const capabilities: Capability[] = [
  { area: "Agent creation", elevenLabs: "Prompts, models, voices, languages, knowledge, tools, personalization, authentication, and turn behavior.", classification: "Native", voniDecision: "Stop treating a generic agent builder as the moat. Configure only what the governed workflow needs." },
  { area: "Voice and language", elevenLabs: "Multilingual voices, turn-taking, pronunciation controls, and voice settings.", classification: "Native", voniDecision: "Buy through an adapter. Own approved wording and measured outcome parity by language." },
  { area: "Model choice", elevenLabs: "Multiple LLMs and custom model connections.", classification: "Native", voniDecision: "Normalize model events and keep institution-owned evaluations." },
  { area: "Web and app channels", elevenLabs: "Web widget plus React, iOS, Android, and React Native SDKs.", classification: "Native", voniDecision: "Do not rebuild commodity clients unless the case experience requires it." },
  { area: "Telephony", elevenLabs: "SIP, Twilio, inbound and outbound calls, encrypted SIP, transfers, and batch calls.", classification: "Native", voniDecision: "Treat transport as replaceable. Own contact authorization and reconciliation." },
  { area: "Messaging", elevenLabs: "WhatsApp text, voice notes, media, and calling subject to Meta permissions.", classification: "Native", voniDecision: "Add channels only through one case timeline and contact-policy gate." },
  { area: "Batch outreach", elevenLabs: "Upload, scheduling, testing, progress tracking, API control, and batch calling.", classification: "Native", voniDecision: "Evolve campaigns into governed case initiation, not a broader dialer." },
  { area: "Workflow builder", elevenLabs: "Visual branching, subagents, conditions, transfers, tool overrides, and analytics.", classification: "Native", voniDecision: "Compile bounded resolution steps into provider workflows where useful." },
  { area: "Structured procedures", elevenLabs: "Ordered ask, tell, exact wording, tools, conditions, retry, and sub-procedures.", classification: "Native", voniDecision: "Use for a session. Keep deadlines and completion state in Voni." },
  { area: "Tools and MCP", elevenLabs: "Client tools, webhooks, enterprise code tools, MCP, and system tools.", classification: "Native", voniDecision: "Differentiate on policy-scoped authorization and durable receipts, not tool calling." },
  { area: "End-user confirmation", elevenLabs: "MCP tools can always ask, selectively ask, or run without approval.", classification: "Native", voniDecision: "Extend confirmation with identity, role, risk, expiry, dual control, and evidence." },
  { area: "Knowledge and RAG", elevenLabs: "Documents, URLs, text, files, full context, and retrieval.", classification: "Native", voniDecision: "A knowledge base is not signed policy with effective dates and permitted actions." },
  { area: "Dynamic personalization", elevenLabs: "Variables can personalize prompts, messages, tools, and behavior.", classification: "Native", voniDecision: "Pass minimum context. Never make provider variables authoritative case state." },
  { area: "Connection authentication", elevenLabs: "Signed URLs and hostname allowlists; the host still authenticates the person.", classification: "Native", voniDecision: "Bind institution-specific identity assurance to permitted actions." },
  { area: "Customer identity proofing", elevenLabs: "Can call identity providers through tools; no general managed proofing layer was evidenced.", classification: "Customer-built", voniDecision: "Provide pluggable verification policies, attempts, assurance, expiry, and evidence." },
  { area: "Users and conversation history", elevenLabs: "External user IDs and conversation timelines.", classification: "Native", voniDecision: "Useful metadata, but not an obligation with owner, deadline, and outcome." },
  { area: "Cross-session business state", elevenLabs: "Webhooks expose transcripts and events; customer examples persist state in customer databases.", classification: "Customer-built", voniDecision: "Make durable business state a managed case ledger." },
  { area: "Agent QA tickets", elevenLabs: "Tickets for agent performance with status, assignment, comments, and conversation links.", classification: "Native", voniDecision: "Acknowledge it accurately. It is not the applicant's case or approval queue." },
  { area: "End-user case management", elevenLabs: "CRM integrations can create or update external cases and tickets.", classification: "Customer-built", voniDecision: "Coexist with systems of record while owning governed orchestration and evidence." },
  { area: "Human transfer", elevenLabs: "Transfer to numbers or agents through conference, blind transfer, and SIP REFER.", classification: "Native", voniDecision: "Send a verified handoff package: facts, open step, policy basis, and receipt." },
  { area: "Decision work queues", elevenLabs: "External CRMs can receive work; no case queue tied to authority and deadlines was evidenced.", classification: "Not managed", voniDecision: "Build exception, dispute, vulnerability, approval, failure, and overdue queues." },
  { area: "Structured extraction", elevenLabs: "Post-call extraction and analysis through APIs and webhooks.", classification: "Native", voniDecision: "Store extraction as a claim with source and confidence, not a verified fact." },
  { area: "Evaluation and testing", elevenLabs: "Success criteria, simulations, tool tests, repeated runs, CLI, API, and dashboards.", classification: "Native", voniDecision: "Add signed policy-conformance and cross-provider parity suites." },
  { area: "Experiments and versioning", elevenLabs: "Traffic experiments and immutable agent configuration snapshots.", classification: "Native", voniDecision: "Experiments stay inside approved bounds; pin cases to signed policy versions." },
  { area: "Guardrails", elevenLabs: "Focus, manipulation, content, and custom guardrails; version reviewed was marked alpha.", classification: "Native", voniDecision: "Use as defense in depth. Block unauthorized execution deterministically in Voni." },
  { area: "Analytics and monitoring", elevenLabs: "Call volume, cost, success, collected data, languages, search, active calls, and workflow metrics.", classification: "Native", voniDecision: "Lead with unresolved cases, resolution time, exceptions, and audit completeness." },
  { area: "OpenTelemetry", elevenLabs: "Conversation traces can be exported to customer collectors.", classification: "Native", voniDecision: "Accept trace references, but retain evidence independently of trace retention." },
  { area: "Workspace roles and SSO", elevenLabs: "Enterprise roles, resource sharing, SAML or OIDC SSO, and SCIM.", classification: "Native", voniDecision: "Integrate institution identity; express roles against actions and thresholds." },
  { area: "Administrative audit logs", elevenLabs: "Enterprise logs across more than 100 administrative endpoints in OCSF format.", classification: "Native", voniDecision: "Keep a separate outcome ledger explaining why a case changed." },
  { area: "Retention and redaction", elevenLabs: "Conversation and audio retention controls plus enterprise redaction.", classification: "Native", voniDecision: "Add case retention, legal holds, selective evidence, and deletion propagation." },
  { area: "Zero retention", elevenLabs: "Available for eligible enterprise API traffic with product caveats; batch is incompatible.", classification: "Native", voniDecision: "Show compatibility before deployment and verify the end-to-end data path." },
  { area: "Residency and private deployment", elevenLabs: "Regional environments plus AWS and GCP private deployment options.", classification: "Native", voniDecision: "Support strong infrastructure controls while governing the complete provider chain." },
  { area: "CRM and service integrations", elevenLabs: "HubSpot, Salesforce, Zendesk, Intercom, and Genesys.", classification: "Native", voniDecision: "Reuse them when suitable, then reconcile every side effect into the case." },
  { area: "Regulated-sector examples", elevenLabs: "First-party government, banking, insurance, and employment-service material.", classification: "Native", voniDecision: "Do not claim an empty market. Sell one precise governed outcome." },
  { area: "Pricing", elevenLabs: "Self-service usage tiers and negotiated enterprise terms.", classification: "Native", voniDecision: "Price governed cases and controls, not voice minutes." },
  { area: "Signed policy packs", elevenLabs: "No approval lifecycle linking reviewers, clauses, wording, tests, actions, and cases was evidenced.", classification: "Not managed", voniDecision: "Make the signed pack a primary object and release gate." },
  { area: "Clause-to-action evidence", elevenLabs: "Transcripts, traces, tool calls, and logs supply ingredients, not a managed case lineage.", classification: "Not managed", voniDecision: "Bind each material statement and execution to its policy and source facts." },
  { area: "Durable authority and dual control", elevenLabs: "Confirmation and workspace permissions do not establish expiring, case-specific authority.", classification: "Needs Voni", voniDecision: "Voni decides whether execution is authorized, even when a provider presents the UI." },
  { area: "Regulated decision ownership", elevenLabs: "Conversation infrastructure can support a process; institutional accountability remains elsewhere.", classification: "Needs Voni", voniDecision: "Keep consequential judgment with an accountable institution actor." },
];

export const workflows = [
  { name: "Proactive application resolution", score: 83, verdict: "Lighthouse", summary: "A narrow, correctable requirement with explicit confirmation and a clean human decision boundary.", strengths: ["Measurable resolution time", "Reversible customer actions", "Reusable across sectors"] },
  { name: "Support through difficult moments", score: 57, verdict: "Later", summary: "High human value, but vulnerability detection is uncertain and mistakes can cause harm.", strengths: ["Strong service value", "Useful escalation layer", "Requires specialist capacity"] },
  { name: "Governed collections", score: 55, verdict: "Not first", summary: "Urgent and valuable, but conduct risk, irreversibility, disputes, and procurement make it a poor first proof.", strengths: ["Clear business pressure", "Heavily regulated", "Narrow informational role only"] },
];

export const platformLayers = [
  { name: "Institution controls", detail: "Tenant isolation, roles, retention, residency, rollout, rollback, and evaluation suites." },
  { name: "Policy and authority", detail: "Signed policy packs, identity assurance, risk levels, expiry, approvers, and dual control." },
  { name: "Case resolution", detail: "Cases, evidence, deterministic plans, deadlines, queues, and reconciliation." },
  { name: "Provider adapters", detail: "Normalized speech, telephony, language, interruption, transfer, transcript, and quality events." },
  { name: "Replaceable infrastructure", detail: "ElevenLabs, AssemblyAI, telephony providers, models, identity services, and source systems." },
];

export const authoritySteps = [
  { name: "Propose", detail: "Describe one permitted action and its inputs." },
  { name: "Read back", detail: "State the consequence in the person's language." },
  { name: "Confirm", detail: "Capture independent, unambiguous assent." },
  { name: "Authorize", detail: "Check identity, role, policy, risk, version, and expiry." },
  { name: "Execute", detail: "Use an idempotent adapter against the source system." },
  { name: "Record", detail: "Append policy, facts, decision, result, and timestamps." },
  { name: "Reconcile", detail: "Verify the authoritative system reached the intended state." },
];

export const examples = [
  {
    sector: "Banking",
    title: "Aisha's proof of address expired",
    situation: "Aisha's application cannot progress because the source system marks one document as expired. She prefers Arabic and cannot visit a branch this week.",
    safePath: ["Voni receives the missing-requirement event and pins the current approved policy.", "The voice provider conducts the call; Voni reveals only what the verified identity level permits.", "Aisha confirms that Voni may send a secure upload link to her verified number.", "The bank system validates the replacement. Voni reconciles the receipt and closes the requirement."],
    humanBoundary: "If Aisha disputes the expiry, the records conflict, or the document needs acceptance judgment, the case goes to a specialist. The agent never approves the application.",
  },
  {
    sector: "Insurance",
    title: "Omar's claim needs one more photograph",
    situation: "A motor claim is stalled because the required rear-angle image is absent, while all other intake items are present.",
    safePath: ["Explain the exact missing item using approved wording.", "Send a time-limited upload request after confirmation.", "Watch for the insurer's authoritative receipt.", "Escalate contradictory or potentially fraudulent evidence without labeling the claimant."],
    humanBoundary: "Voni can resolve completeness. A licensed or authorized claims employee decides coverage, fraud concerns, and settlement.",
  },
  {
    sector: "Government",
    title: "Maya's permit renewal lacks a tenancy record",
    situation: "A permit renewal is incomplete and the applicant is unsure which tenancy document the authority accepts.",
    safePath: ["Explain the published requirement in the applicant's language.", "Offer an accessible text summary and secure submission route.", "Track the deadline across voice and web interactions.", "Hand off any exception request with the policy clause and conversation summary."],
    humanBoundary: "The authority decides eligibility and accepts exceptions. Voni keeps the explanation, evidence, and next step coherent across channels.",
  },
];

export const roadmap = [
  { phase: "0", timing: "4–6 weeks", name: "Prove the problem", work: "Map one real policy and historical case set, baseline outcomes, test mockups, define authority, queues, and stop rules.", gate: "The institution agrees Voni owns governed orchestration and evidence, not only the voice front end." },
  { phase: "1", timing: "8–12 weeks", name: "Controlled lighthouse", work: "Ship signed policy versions, cases, one source trigger, one secure action, one provider adapter, a specialist queue, and full evidence view.", gate: "Zero unauthorized executions and complete evidence for every closed case." },
  { phase: "2", timing: "3–6 months", name: "Harden and repeat", work: "Add a second provider, promotion and rollback, retention, dual control, a second requirement, and a second language after parity evidence.", gate: "Changing provider does not change case semantics or historical reconstruction." },
  { phase: "3", timing: "6–12 months", name: "Expand the pattern", work: "Reuse application resolution in insurance, permits, licenses, benefits, and claims; certify partners only after repeated validation.", gate: "Most control and domain work is reused, while policy remains institution-approved." },
];

export const pilotMetrics = [
  "Corrected without a visit",
  "Median time to resolution",
  "Repeat-contact rate",
  "Human handling time",
  "Policy deviations",
  "Unsafe-action attempts",
  "Escalation quality",
  "Language completion parity",
  "Audit reconstruction time",
];

export const stopConditions = [
  "Institutions only want a generic voice agent.",
  "A design partner cannot supply approved policy, anonymized cases, integration access, and escalation staff.",
  "Buyers will not pay for controlled execution and audit reconstruction.",
  "Source systems cannot provide reliable triggers or execution receipts.",
  "Automation increases complaints, unresolved exceptions, or unequal language outcomes.",
];

export const commercialModel = [
  "Annual platform and control-plane fee by environment and institution scope.",
  "Governed active-case or resolved-case volume, with clear treatment of reopened cases.",
  "Implementation and policy-pack setup for the initial workflow.",
  "Optional language review, provider qualification, evaluation, and audit-export packages.",
  "Voice, telephony, model, and verification usage passed through transparently or contracted directly.",
];

export const strategicRisks = [
  { risk: "Existing case platforms absorb the layer", signal: "Design partners want their CRM to own policy, authority, evidence, and orchestration.", response: "Offer a thin control plane only if it still owns meaningful authority and evidence; otherwise do not enter on this thesis." },
  { risk: "ElevenLabs expands upward", signal: "It releases signed policy approval, case-specific authority, lineage, and cross-system reconciliation.", response: "Deepen multi-provider, cross-channel institution workflows and reassess build areas quarterly." },
  { risk: "Policy authoring stays bespoke", signal: "Deployments share little repeatable structure.", response: "Constrain the workflow, measure reuse, template only repeated patterns, and price services honestly." },
  { risk: "Integration dominates value", signal: "Source systems cannot supply trusted triggers or receipts.", response: "Select the lighthouse partly on event and API readiness; never present manual reconciliation as automation." },
  { risk: "Human queues become the bottleneck", signal: "Automation creates more exceptions, rework, or aging.", response: "Measure queue arrival and handling from shadow mode; tighten eligibility before increasing volume." },
  { risk: "Multilingual parity fails", signal: "Resolution, escalation, or complaint outcomes diverge by language.", response: "Pause expansion, use reviewed language packs, test understanding, and retain a human path in the requested language." },
  { risk: "Evidence costs exceed value", signal: "Reconstruction creates excessive storage, review, or latency.", response: "Retain references and hashes where possible, tier evidence by materiality, and validate needs with real auditors." },
  { risk: "Abstraction erases provider strengths", signal: "Portability becomes lowest-common-denominator behavior.", response: "Keep capability profiles and certify workflow-provider combinations instead of claiming universal interchangeability." },
  { risk: "Decision scope creeps", signal: "Teams ask the agent to waive, approve, score, negotiate, or make adverse decisions.", response: "Make prohibited actions structural and treat unauthorized execution as a pilot stop event." },
];

export const discoveryQuestions = [
  "Which correctable application requirement creates the largest delay without requiring judgment?",
  "Can the source system emit a trusted trigger and an authoritative resolution receipt?",
  "What information may be disclosed at each identity-assurance level?",
  "How is the launch call classified: service, marketing, or another category?",
  "Which recording, AI disclosure, consent, suppression, and frequency rules apply?",
  "Which policy phrases must be exact, which may be paraphrased, and who signs each language?",
  "What makes a requirement disputed, vulnerable, urgent, or unsuitable for automation?",
  "Who may approve each action, and which actions require two people or segregation of duties?",
  "Which system wins when Voni and the source record disagree?",
  "What evidence do compliance, complaints, audit, privacy, and operations reviewers need?",
  "What are the baseline resolution, repeat-contact, staff-effort, complaint, abandonment, and language outcomes?",
  "Will specialists work in Voni, through its APIs, or entirely in an existing system?",
  "Which provider deployment, retention, residency, and zero-retention combinations are acceptable?",
  "What result makes the institution expand, pause, or terminate the pilot?",
];

export const sources = [
  { group: "ElevenLabs platform", title: "ElevenAgents overview", href: "https://elevenlabs.io/docs/eleven-agents/overview" },
  { group: "ElevenLabs platform", title: "Agent workflows", href: "https://elevenlabs.io/docs/eleven-agents/customization/agent-workflows" },
  { group: "ElevenLabs platform", title: "Structured procedures", href: "https://elevenlabs.io/docs/eleven-agents/customization/procedures/structured-procedures" },
  { group: "ElevenLabs platform", title: "Tools and MCP approvals", href: "https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp" },
  { group: "ElevenLabs platform", title: "Agent testing", href: "https://elevenlabs.io/docs/eleven-agents/customization/agent-testing" },
  { group: "ElevenLabs platform", title: "Versioning", href: "https://elevenlabs.io/docs/eleven-agents/operate/versioning" },
  { group: "ElevenLabs platform", title: "Guardrails", href: "https://elevenlabs.io/docs/eleven-agents/best-practices/guardrails" },
  { group: "ElevenLabs platform", title: "Agent analytics", href: "https://elevenlabs.io/docs/eleven-agents/dashboard" },
  { group: "ElevenLabs platform", title: "Triage tickets", href: "https://elevenlabs.io/docs/eleven-agents/api-reference/triage-tickets/list" },
  { group: "ElevenLabs platform", title: "SIP trunking", href: "https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking" },
  { group: "ElevenLabs platform", title: "Batch calls", href: "https://elevenlabs.io/docs/eleven-agents/phone-numbers/batch-calls" },
  { group: "ElevenLabs platform", title: "Privacy", href: "https://elevenlabs.io/docs/eleven-agents/customization/privacy" },
  { group: "ElevenLabs platform", title: "Data residency", href: "https://elevenlabs.io/docs/overview/administration/data-residency" },
  { group: "ElevenLabs platform", title: "Private deployment", href: "https://elevenlabs.io/docs/overview/capabilities/private-deployment" },
  { group: "ElevenLabs platform", title: "Agents pricing", href: "https://elevenlabs.io/pricing/agents" },
  { group: "UAE", title: "CBUAE Consumer Protection Standards", href: "https://rulebook.centralbank.ae/en/rulebook/consumer-protection-standards" },
  { group: "UAE", title: "Telemarketing controls", href: "https://rulebook.centralbank.ae/en/rulebook/part-2-telemarketing-controls" },
  { group: "UAE", title: "Cabinet Resolution No. 56 of 2024", href: "https://uaelegislation.gov.ae/en/legislations/2519" },
  { group: "UAE", title: "Complaint management and resolution", href: "https://rulebook.centralbank.ae/en/rulebook/article-6-complaint-management-and-resolution" },
  { group: "UAE", title: "Data protection laws", href: "https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws" },
  { group: "Europe and UK", title: "EU AI Act framework", href: "https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai" },
  { group: "Europe and UK", title: "General Data Protection Regulation", href: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679" },
  { group: "Europe and UK", title: "FCA Consumer Duty", href: "https://www.fca.org.uk/firms/consumer-duty/information-firms" },
  { group: "Europe and UK", title: "FCA vulnerable customers practice", href: "https://www.fca.org.uk/publications/good-and-poor-practice/delivering-vulnerable-customers" },
  { group: "Global controls", title: "Canada Directive on Automated Decision-Making", href: "https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32592" },
  { group: "Global controls", title: "FCC decision on AI-generated voices", href: "https://docs.fcc.gov/public/attachments/DOC-400393A1.pdf" },
  { group: "Global controls", title: "European Accessibility Act", href: "https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32019L0882" },
  { group: "Global controls", title: "WCAG 2.2", href: "https://www.w3.org/TR/WCAG22/" },
  { group: "Global controls", title: "NIST AI Risk Management Framework", href: "https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10" },
  { group: "Global controls", title: "ISO/IEC 42001", href: "https://www.iso.org/standard/42001" },
];

export const sourceGroups = Array.from(new Set(sources.map((source) => source.group)));
