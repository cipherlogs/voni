import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowDown,
  ArrowRight,
  BookOpenCheck,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FileCheck2,
  Gauge,
  Languages,
  LockKeyhole,
  Network,
  ShieldCheck,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import {
  authoritySteps,
  capabilities,
  capabilityLegend,
  commercialModel,
  discoveryQuestions,
  examples,
  pilotMetrics,
  platformLayers,
  roadmap,
  sourceGroups,
  sources,
  stopConditions,
  strategicRisks,
  workflows,
  type CapabilityClass,
} from "./content";
import styles from "./strategy.module.css";

export const metadata: Metadata = {
  title: "Voni strategy | Governed case resolution",
  description:
    "An evidence-backed product strategy for Voni as a provider-independent governed case-resolution platform.",
};

const sections = [
  ["decision", "The decision"],
  ["market", "Market reality"],
  ["lighthouse", "Lighthouse workflow"],
  ["example", "A case in practice"],
  ["platform", "The product"],
  ["authority", "Safe execution"],
  ["operating-model", "Who owns what"],
  ["portability", "Regulatory portability"],
  ["validation", "Proof before build"],
  ["roadmap", "Roadmap"],
  ["evidence", "Evidence base"],
] as const;

const classVariant: Record<CapabilityClass, "default" | "secondary" | "outline" | "destructive"> = {
  Native: "secondary",
  "Customer-built": "outline",
  "Not managed": "default",
  "Needs Voni": "destructive",
};

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className={styles.sectionHeading}>
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function CitationLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className={styles.citation} href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink aria-hidden="true" />
    </a>
  );
}

export default function StrategyPresentationPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#strategy-content">
        Skip to strategy
      </a>

      <header className={styles.topbar}>
        <Link className={styles.wordmark} href="/dashboard" aria-label="Voni dashboard">
          <span aria-hidden="true" className={styles.brandMark}>V</span>
          <span>Voni</span>
        </Link>
        <div className={styles.topbarMeta}>
          <Badge variant="outline">Strategy brief</Badge>
          <span className={styles.researchDate}>Research current to 13 Sep 2026</span>
        </div>
      </header>

      <details className={styles.mobileToc}>
        <summary><span>On this page</span><ChevronDown aria-hidden="true" /></summary>
        <nav aria-label="Mobile table of contents">
          {sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </nav>
      </details>

      <div className={styles.shell}>
        <aside className={styles.rail} aria-label="On this page">
          <p className={styles.railTitle}>On this page</p>
          <nav>
            {sections.map(([id, label]) => (
              <a key={id} href={`#${id}`}>{label}</a>
            ))}
          </nav>
          <div className={styles.railNote}>
            <ShieldCheck aria-hidden="true" />
            <p><strong>Core test</strong> Voni must still matter when the institution already owns ElevenLabs.</p>
          </div>
        </aside>

        <main id="strategy-content" className={styles.main}>
          <section id="decision" className={styles.hero}>
            <div className={styles.heroCopy}>
              <h1>Do not build another voice-agent platform.</h1>
              <p className={styles.heroLead}>
                Build the governed case-resolution layer that turns approved institutional policy into work that agents, employees, and external systems can advance safely over time.
              </p>
              <p className={styles.scopeNote}><strong>Decision brief.</strong> Product strategy, not legal advice. Every deployment still requires institution and jurisdiction-specific review.</p>
              <div className={styles.heroActions}>
                <a className={cn(buttonVariants({ size: "lg" }), styles.primaryAction)} href="#lighthouse">
                  See the first workflow
                  <ArrowDown data-icon="inline-end" aria-hidden="true" />
                </a>
                <a className={buttonVariants({ variant: "outline", size: "lg" })} href="#market">
                  Review the evidence
                </a>
              </div>
            </div>

            <div className={styles.decisionCard} role="group" aria-label="Strategic category comparison">
              <div className={styles.decisionBefore}>
                <span>Commodity category</span>
                <strong>Voice agent builder</strong>
                <p>Prompts, voices, calls, workflows, tools, analytics.</p>
              </div>
              <ArrowDown aria-hidden="true" />
              <div className={styles.decisionAfter}>
                <span>Recommended Voni category</span>
                <strong>Governed case resolution</strong>
                <p>Policy, authority, evidence, deadlines, people, and cross-session outcomes.</p>
              </div>
            </div>

            <blockquote className={styles.positioning}>
              “ElevenLabs can run an excellent conversation. Voni governs the institutional case that the conversation is allowed to advance.”
            </blockquote>
          </section>

          <section id="market" className={styles.section}>
            <SectionHeading
              title="The horizontal conversation layer is already strong"
              description="ElevenLabs covers nearly every generic capability a voice-agent roadmap could chase. The opportunity is above that layer, where the institution's obligation persists after a call ends."
            />

            <div className={styles.splitDiagram} role="group" aria-label="ElevenLabs and Voni ownership boundary">
              <div className={styles.providerSide}>
                <div className={styles.diagramTitle}>
                  <Languages aria-hidden="true" />
                  <div><span>Conversation runtime</span><strong>ElevenLabs can own</strong></div>
                </div>
                <ul>
                  <li>Speech, voices, languages</li>
                  <li>Turn-taking and interruption</li>
                  <li>Session workflows and tools</li>
                  <li>Telephony, transfers, transcripts</li>
                  <li>Agent versions, QA, analytics</li>
                </ul>
              </div>
              <div className={styles.boundary}>
                <ArrowRight aria-hidden="true" />
                <span>events, tools, receipts</span>
              </div>
              <div className={styles.voniSide}>
                <div className={styles.diagramTitle}>
                  <LockKeyhole aria-hidden="true" />
                  <div><span>Institutional control plane</span><strong>Voni must own</strong></div>
                </div>
                <ul>
                  <li>Case identity, lifecycle, deadline</li>
                  <li>Signed policy and clause selection</li>
                  <li>Verified facts and provenance</li>
                  <li>Authority, approval, dual control</li>
                  <li>Resolution, reconciliation, audit</li>
                </ul>
              </div>
            </div>

            <div className={styles.evidenceCallout}>
              <BookOpenCheck aria-hidden="true" />
              <p>
                This is not a claim that ElevenLabs lacks enterprise controls. Its documentation covers workflows, testing, guardrails, versioning, SSO, audit logs, privacy, residency, and private deployment. The gap is managed ownership of the institution's case, policy authority, and cross-system outcome. <CitationLink href="https://elevenlabs.io/docs/eleven-agents/overview">Product overview</CitationLink>
              </p>
            </div>

            <details className={styles.matrix}>
              <summary>
                <span><strong>Complete capability matrix</strong><small>{capabilities.length} product areas reviewed</small></span>
                <span className={styles.summaryHint}>Open matrix <ChevronDown aria-hidden="true" /></span>
              </summary>
              <div className={styles.legend}>
                {capabilityLegend.map((item) => (
                  <div key={item.label}>
                    <Badge variant={classVariant[item.label]}>{item.label}</Badge>
                    <span>{item.meaning}</span>
                  </div>
                ))}
              </div>
              <div className={styles.tableWrap} role="region" tabIndex={0} aria-label="Scrollable ElevenLabs capability matrix">
                <table>
                  <thead><tr><th>Area</th><th>What ElevenLabs offers</th><th>Class</th><th>What Voni should do</th></tr></thead>
                  <tbody>
                    {capabilities.map((capability) => (
                      <tr key={capability.area}>
                        <th scope="row">{capability.area}</th>
                        <td>{capability.elevenLabs}</td>
                        <td><Badge variant={classVariant[capability.classification]}>{capability.classification}</Badge></td>
                        <td>{capability.voniDecision}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            <div className={styles.pivotMap}>
              <div>
                <Badge variant="secondary">Keep and harden</Badge>
                <h3>The safety foundations</h3>
                <p>Organization boundaries, durable jobs, calling and consent controls, voice mutation confirmation, and the signed-in copilot.</p>
              </div>
              <div>
                <Badge variant="outline">Transform</Badge>
                <h3>Operational objects</h3>
                <p>Agents become runtime assets. Campaigns initiate cases. Leads become parties. Calls and messages become evidence. Tool logs become receipts.</p>
              </div>
              <div>
                <Badge variant="destructive">Stop leading with</Badge>
                <h3>Generic feature breadth</h3>
                <p>A blank agent builder, broad workflow canvas, voice catalogue, dialer breadth, generic RAG, and call-volume analytics.</p>
              </div>
            </div>
          </section>

          <section id="lighthouse" className={styles.section}>
            <SectionHeading
              title="Start with proactive application resolution"
              description="It offers the best first proof: a narrow trigger, a correctable condition, measurable delay, reversible customer actions, and a human decision boundary that is easy to explain."
            />

            <div className={styles.scoreGrid}>
              {workflows.map((workflow) => (
                <Card key={workflow.name} className={workflow.verdict === "Lighthouse" ? styles.winnerCard : undefined}>
                  <CardHeader>
                    <div className={styles.cardTopline}>
                      <Badge variant={workflow.verdict === "Lighthouse" ? "default" : "outline"}>{workflow.verdict}</Badge>
                      <span className={styles.score}>{workflow.score}<small>/100</small></span>
                    </div>
                    <CardTitle as="h3">{workflow.name}</CardTitle>
                    <CardDescription>{workflow.summary}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Progress value={workflow.score} aria-label={`${workflow.name} score`}>
                      <ProgressLabel>Weighted score</ProgressLabel>
                      <ProgressValue>{workflow.score}%</ProgressValue>
                    </Progress>
                    <ul className={styles.compactList}>
                      {workflow.strengths.map((strength) => <li key={strength}><Check aria-hidden="true" />{strength}</li>)}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>

            <p className={styles.methodNote}>
              Weighted across urgency, measurable value, regulatory safety, reversibility, integration ease, procurement ease, data readiness, competitive whitespace, reuse, and pilot credibility. Collections scores well on urgency and value but poorly on safety and reversibility. Difficult-moment support has real value, but vulnerability detection should be an escalation aid, not the first autonomous proof.
            </p>
          </section>

          <section id="example" className={styles.section}>
            <SectionHeading
              title="What a governed case feels like in practice"
              description="These are illustrative scenarios, not customer claims. They show the reusable pattern and the point where automation must stop."
            />

            <article className={styles.story}>
              <div className={styles.storyIntro}>
                <Badge variant="secondary">Illustrative banking case</Badge>
                <h3>{examples[0].title}</h3>
                <p>{examples[0].situation}</p>
              </div>
              <div className={styles.caseFlow}>
                {[
                  ["09:00", "Case opened", "The bank marks proof of address as expired. Voni selects policy v4.2 and starts a deadline."],
                  ["10:14", "Identity bounded", "Aisha verifies enough information to discuss the missing requirement, not the application decision."],
                  ["10:17", "Action confirmed", "After an Arabic readback, she confirms a secure link may be sent to her verified number."],
                  ["10:26", "Source reconciled", "The bank records the replacement. Voni stores the receipt and closes only the missing requirement."],
                ].map(([time, title, copy], index) => (
                  <div className={styles.caseStep} key={title}>
                    <span className={styles.caseTime}>{time}</span>
                    <span className={styles.caseNode}>{index + 1}</span>
                    <div><strong>{title}</strong><p>{copy}</p></div>
                  </div>
                ))}
              </div>
              <div className={styles.humanBoundary}>
                <Users aria-hidden="true" />
                <div><strong>Human decision boundary</strong><p>{examples[0].humanBoundary}</p></div>
              </div>
            </article>

            <div className={styles.exampleGrid}>
              {examples.slice(1).map((example) => (
                <Card key={example.sector}>
                  <CardHeader>
                    <Badge variant="outline">{example.sector}</Badge>
                    <CardTitle as="h3">{example.title}</CardTitle>
                    <CardDescription>{example.situation}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ol className={styles.numberedList}>
                      {example.safePath.map((step) => <li key={step}>{step}</li>)}
                    </ol>
                    <p className={styles.boundaryCopy}><strong>Stops here:</strong> {example.humanBoundary}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section id="platform" className={styles.section}>
            <SectionHeading
              title="The product is a case and control plane"
              description="Provider independence is architectural, not rhetorical. Voice, telephony, models, and source systems sit beneath stable institution-owned semantics."
            />

            <div className={styles.layerStack} role="group" aria-label="Voni capability architecture">
              {platformLayers.map((layer, index) => (
                <div className={styles.layer} key={layer.name}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div><strong>{layer.name}</strong><p>{layer.detail}</p></div>
                </div>
              ))}
            </div>

            <div className={styles.objectGrid}>
              {[
                [FileCheck2, "Policy packs", "Approved wording, actions, calling rules, sources, jurisdiction, dates, reviewers, and signed versions."],
                [Network, "Cases", "One durable record across calls, messages, documents, systems, deadlines, requirements, and responsible parties."],
                [LockKeyhole, "Authority gates", "Risk, verification, reversibility, allowed actor, approver, expiry, and dual control."],
                [BookOpenCheck, "Evidence records", "Clause, source version, facts, tool results, statement, approval, execution, and timestamps."],
                [Gauge, "Resolution plans", "Deterministic required steps with bounded conversational flexibility."],
                [Users, "Human work queues", "Exceptions, disputes, vulnerability signals, uncertain rules, approvals, failures, and overdue cases."],
              ].map(([Icon, title, copy]) => {
                const ItemIcon = Icon as typeof FileCheck2;
                return (
                  <div className={styles.objectItem} key={title as string}>
                    <ItemIcon aria-hidden="true" />
                    <div><h3>{title as string}</h3><p>{copy as string}</p></div>
                  </div>
                );
              })}
            </div>

            <div className={styles.buildBuy}>
              <div>
                <span className={styles.decisionLabel}>Buy or integrate</span>
                <p>Voice runtime, telephony, messaging, general conversation workflows, generic RAG, identity proofing, systems of record, and observability.</p>
              </div>
              <div>
                <span className={styles.decisionLabel}>Build and own</span>
                <p>Case orchestration, signed policy lifecycle, authority service, evidence ledger, reconciliation, human queues, provider adapters, and parity evaluation.</p>
              </div>
            </div>

            <div className={styles.interfaceIntro}>
              <h3>Three surfaces make the operating model concrete</h3>
              <p>The first release is not a blank workflow canvas. Each surface is organized around an institution-owned decision and the evidence needed to make it.</p>
            </div>

            <div className={styles.mockupNote}><Badge variant="outline">Illustrative interfaces</Badge><span>Static concept views, not interactive product controls.</span></div>
            <div className={styles.mockupGrid}>
              <figure className={styles.mockup}>
                <header><span>Policy studio</span><Badge variant="secondary">Draft v4.2</Badge></header>
                <div className={styles.mockupBody}>
                  <div className={styles.mockupNav}><strong>Application resolution</strong><span>Sources</span><span>Wording</span><span>Actions</span><span>Tests</span><span>Approvals</span></div>
                  <div className={styles.policyCanvas}>
                    <span className={styles.mockLabel}>Source clause</span>
                    <p>Proof of address must be current at the time of review.</p>
                    <div className={styles.mappingArrow}><ArrowDown aria-hidden="true" /></div>
                    <span className={styles.mockLabel}>Permitted action</span>
                    <strong>Send secure upload link</strong>
                    <div className={styles.approvalRow}><span>Arabic wording</span><Badge variant="outline">Legal review</Badge></div>
                  </div>
                </div>
                <figcaption><ShieldCheck aria-hidden="true" /><span>Voni drafts and validates. The institution signs and publishes.</span></figcaption>
              </figure>

              <figure className={styles.mockup}>
                <header><span>Exception workspace</span><Badge variant="destructive">7 need attention</Badge></header>
                <div className={styles.mockupBody}>
                  <div className={styles.caseList}><strong>Assigned to me</strong><span className={styles.activeCase}>Conflicting document dates<small>Due in 42 min</small></span><span>Identity attempts exceeded<small>Due today</small></span><span>Requested accommodation<small>New</small></span></div>
                  <div className={styles.evidenceCanvas}>
                    <span className={styles.mockLabel}>Case AR-1048</span>
                    <strong>One fact needs judgment</strong>
                    <p>Source A says 12 Aug. Uploaded document says 21 Aug.</p>
                    <div className={styles.evidenceLine}><span>Policy</span><strong>Clause 3.1.4</strong></div>
                    <div className={styles.evidenceLine}><span>Last action</span><strong>Blocked safely</strong></div>
                    <div className={styles.mockAction}><span>Proposed specialist action</span><strong>Review evidence</strong><ArrowRight aria-hidden="true" /></div>
                  </div>
                </div>
                <figcaption><Users aria-hidden="true" /><span>The specialist receives the unresolved step, verified facts, policy basis, and deadline.</span></figcaption>
              </figure>

              <figure className={styles.mockup}>
                <header><span>Deployment control</span><Badge variant="outline">Pilot</Badge></header>
                <div className={styles.deploymentCanvas}>
                  <div className={styles.environmentRow}><div><span>Production candidate</span><strong>Application resolution · v4.2</strong></div><Badge variant="secondary">Ready for approval</Badge></div>
                  <div className={styles.providerRoute}>
                    <span>Voni case plane</span><ArrowRight aria-hidden="true" /><span>ElevenLabs voice</span><ArrowRight aria-hidden="true" /><span>Bank source API</span>
                  </div>
                  <div className={styles.checkRows}><span><Check aria-hidden="true" />312 policy tests passed</span><span><Check aria-hidden="true" />Arabic parity within threshold</span><span><Check aria-hidden="true" />Rollback target pinned</span></div>
                  <div className={styles.jobStatus}><span>Provider qualification export</span><strong>Running in background · 64%</strong></div>
                </div>
                <figcaption><Network aria-hidden="true" /><span>Voni or a certified partner configures providers. Institution owners approve the release.</span></figcaption>
              </figure>
            </div>
          </section>

          <section id="authority" className={styles.section}>
            <SectionHeading
              title="Every mutation follows the same safe path"
              description="Conversation can stay flexible. Consequential action cannot. The server rechecks every permission and records the result."
            />

            <div className={styles.authorityFlow} role="group" aria-label="Safe action lifecycle">
              {authoritySteps.map((step, index) => (
                <div className={styles.authorityStep} key={step.name}>
                  <span>{index + 1}</span>
                  <strong>{step.name}</strong>
                  <p>{step.detail}</p>
                  {index < authoritySteps.length - 1 ? <ArrowRight aria-hidden="true" /> : null}
                </div>
              ))}
            </div>

            <div className={styles.actionBoundary}>
              <div>
                <h3><Check aria-hidden="true" />Safe for bounded automation</h3>
                <ul><li>Explain the exact missing requirement</li><li>Send a secure upload link after confirmation</li><li>Schedule a callback</li><li>Update a contact preference after readback</li></ul>
              </div>
              <div>
                <h3><CircleAlert aria-hidden="true" />Institution actor required</h3>
                <ul><li>Waive a requirement</li><li>Accept or reject a document</li><li>Approve, price, or score an application</li><li>Make fraud, AML, sanctions, or adverse decisions</li></ul>
              </div>
            </div>

            <div className={styles.lifecycleBlock}>
              <div>
                <h3>Case lifecycle</h3>
                <div className={styles.lifecycle} role="group" aria-label="Case lifecycle states">
                  {[
                    "Initiated",
                    "Verification",
                    "Active",
                    "Awaiting customer",
                    "Awaiting institution",
                    "Resolved",
                    "Closed",
                  ].map((state, index, states) => (
                    <div key={state}><span>{state}</span>{index < states.length - 1 ? <ArrowRight aria-hidden="true" /> : null}</div>
                  ))}
                </div>
                <p>A disputed, unsafe, expired, or failed step branches to an exception state without losing the original obligation or evidence.</p>
              </div>
              <div>
                <h3>Service contracts</h3>
                <div className={styles.apiList}>
                  <code>POST /policy-versions/:id/publish</code>
                  <code>POST /cases</code>
                  <code>POST /cases/:id/identity-verifications</code>
                  <code>POST /cases/:id/actions/propose</code>
                  <code>POST /actions/:id/confirm</code>
                  <code>POST /actions/:id/authorize</code>
                  <code>POST /actions/:id/execute</code>
                  <code>POST /cases/:id/escalate</code>
                  <code>POST /cases/:id/close</code>
                </div>
                <p>Every mutation carries an expected case version and idempotency key. Long operations return <code>202</code> with a durable job reference.</p>
              </div>
            </div>

            <p className={styles.asyncNote}><strong>Slow work is durable.</strong> Policy validation, source sync, document checks, exports, tests, and provider operations return a job ID after durable acceptance. Status survives navigation and appears globally and on the case. Live calls remain foreground sessions.</p>
          </section>

          <section id="operating-model" className={styles.section}>
            <SectionHeading
              title="Voni configures; the institution approves"
              description="Begin as a Voni-managed implementation with institutional sign-off. Move toward self-service only after the same case pattern has repeated safely."
            />
            <div className={styles.responsibilityMap}>
              {[
                ["Institution policy owner", "Source policy, interpretation, exact wording, legal basis, effective dates, final sign-off."],
                ["Operations owner", "Process, source-system rules, queues, staffing, service levels, and baseline outcomes."],
                ["Compliance and legal", "Jurisdictional review, approval or rejection, and launch conditions."],
                ["Security and privacy", "Data classification, access, retention, residency, incident handling, and provider acceptance."],
                ["Voni implementation", "Policy-pack drafting, workflow configuration, adapters, tests, evidence mapping, training, and monitoring."],
                ["Institution technology or partner", "Source-system integration, secure networking, identity integration, and local change management."],
              ].map(([owner, work]) => (
                <div key={owner}><strong>{owner}</strong><p>{work}</p></div>
              ))}
            </div>
            <div className={styles.operatingRule}>
              <ShieldCheck aria-hidden="true" />
              <p>Voni may prepare a policy version. Only an authorized institution reviewer can approve it. Voni may recommend an action design. Only the institution defines authority and owns the customer outcome.</p>
            </div>
          </section>

          <section id="portability" className={styles.section}>
            <SectionHeading
              title="Portable controls, jurisdiction-specific policy"
              description="The product should encode recurring control patterns without pretending that one policy is globally compliant. Every deployment still needs local review."
            />
            <div className={styles.regulationGrid}>
              {[
                ["UAE financial services", "Contact windows, identity and purpose disclosure, consent and suppression, vulnerable-consumer escalation, complaints, records, and data controls.", "CBUAE and UAE rules determine the exact scope."],
                ["European Union", "AI disclosure and risk classification, logging, human oversight, purpose limitation, minimization, correction, and safeguards for significant decisions.", "Classification depends on the actual use and decision effect."],
                ["United Kingdom", "Good customer outcomes, service adaptations, vulnerability support, and cohort monitoring.", "A vulnerability signal cannot become an adverse label."],
                ["Canada public sector", "Impact assessment, notice, explanation, testing, monitoring, recourse, and calibrated human intervention.", "The federal directive is not a global public-sector rule."],
                ["United States calls", "Consent, disclosure, suppression, and purpose-specific contact rules for artificial or prerecorded voices.", "Federal and state requirements vary."],
                ["Accessibility and AI governance", "Accessible web and text alternatives, language and pace controls, risk inventory, testing, monitoring, change control, and incident evidence.", "Voice alone is not an accessible service."],
              ].map(([title, response, boundary]) => (
                <Card key={title} size="sm">
                  <CardHeader><CardTitle as="h3">{title}</CardTitle></CardHeader>
                  <CardContent><p>{response}</p><small>{boundary}</small></CardContent>
                </Card>
              ))}
            </div>
            <p className={styles.policyRule}>Never encode “global consent,” “global disclosure,” or “global safe calling hours” as booleans. Store the jurisdiction, scope, dates, source, channel, purpose, exact behavior, reviewer, and test. If selection is uncertain, block and route review.</p>
          </section>

          <section id="validation" className={styles.section}>
            <SectionHeading
              title="Prove demand before funding the platform"
              description="The commercial thesis is governed-case value, not margin on voice minutes. The biggest risks should be made observable during discovery and shadow mode."
            />

            <div className={styles.commercialBlock}>
              <div><span>Commercial hypothesis</span><h3>Charge for the control plane and resolved work</h3><p>Let institutions contract voice infrastructure directly or pass it through transparently. Voni earns for case governance, implementation, and evidence.</p></div>
              <ul>{commercialModel.map((item) => <li key={item}><Check aria-hidden="true" />{item}</li>)}</ul>
            </div>

            <details className={styles.riskTable}>
              <summary><span><strong>Strategic risks and disconfirming evidence</strong><small>{strategicRisks.length} ways the thesis can fail</small></span><span className={styles.summaryHint}>Open risks <ChevronDown aria-hidden="true" /></span></summary>
              <div className={styles.tableWrap} role="region" tabIndex={0} aria-label="Scrollable strategy risk table">
                <table>
                  <thead><tr><th>Risk</th><th>Disconfirming signal</th><th>Response</th></tr></thead>
                  <tbody>{strategicRisks.map((item) => <tr key={item.risk}><th scope="row">{item.risk}</th><td>{item.signal}</td><td>{item.response}</td></tr>)}</tbody>
                </table>
              </div>
            </details>

            <div className={styles.discoveryBlock}>
              <h3>Fourteen questions to answer before build</h3>
              <ol>{discoveryQuestions.map((question) => <li key={question}>{question}</li>)}</ol>
            </div>
          </section>

          <section id="roadmap" className={styles.section}>
            <SectionHeading
              title="Earn the platform one phase at a time"
              description="The roadmap begins with evidence and one workflow. Provider abstraction and sector expansion follow proof, not hope."
            />
            <div className={styles.roadmap}>
              {roadmap.map((item) => (
                <article key={item.phase}>
                  <div className={styles.phaseNumber}>{item.phase}</div>
                  <div className={styles.phaseBody}>
                    <span>{item.timing}</span><h3>{item.name}</h3><p>{item.work}</p>
                    <div><strong>Advance only when</strong>{item.gate}</div>
                  </div>
                </article>
              ))}
            </div>

            <div className={styles.measureGrid}>
              <div>
                <h3>What the pilot measures</h3>
                <ul className={styles.metricList}>{pilotMetrics.map((metric) => <li key={metric}><Check aria-hidden="true" />{metric}</li>)}</ul>
              </div>
              <div>
                <h3>When to stop</h3>
                <ul className={styles.stopList}>{stopConditions.map((condition) => <li key={condition}><CircleAlert aria-hidden="true" />{condition}</li>)}</ul>
              </div>
            </div>
          </section>

          <section id="evidence" className={styles.section}>
            <SectionHeading
              title="Evidence base"
              description="Primary and first-party sources used for the product comparison and representative regulatory patterns. Provider marketing and pricing should be rechecked before a commercial decision."
            />
            <div className={styles.sourceGroups}>
              {sourceGroups.map((group) => (
                <div key={group}>
                  <h3>{group}</h3>
                  <ul>
                    {sources.filter((source) => source.group === group).map((source) => (
                      <li key={source.href}><CitationLink href={source.href}>{source.title}</CitationLink></li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <Separator />
            <div className={styles.finalDecision}>
              <span>Recommended category</span>
              <h2>Governed case resolution</h2>
              <p>Voni turns approved institutional policy into auditable, multilingual work that AI agents, employees, and external systems can advance safely over time.</p>
              <a className={buttonVariants({ variant: "outline", size: "lg" })} href="#decision">Back to the decision</a>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
