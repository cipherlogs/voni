# Landing competitor swipe file (fetched 2026-09-24)

> Source: live landing pages fetched via markdown. Verbatim copy in quotes. No Voni claims invented — per PRODUCT.md, Voni has no testimonials, benchmarks, or pricing to cite yet.
> Note on #5: `air.ai` (the voice-AI sales rep) now resolves to Air Enterprise Readiness, a defense company (ex-Govini). `tryair.ai` is an unrelated macOS copilot. Substituted Thoughtly (`thoughtly.com`) — closest live match for CRM-driven voice + SMS/WhatsApp lead follow-up.

## How to use this file
- Each competitor: Hero / Sub / CTAs / Sections in order / Proof / Pricing / Voni takeaway.
- Voni takeaways map to `voni/src/app/page.tsx` (hero), `landing-demo.tsx` (demo widget), `landing-grid-list.tsx` (feature grid).
- Cross-cutting patterns + steal-list at the bottom.

## Section patterns across all 10 (common order)
1. Nav (Product / Solutions / Pricing / Customers / Docs) + dual CTA (Get started + Book demo)
2. Hero: eyebrow badge + outcome headline + 1-2 line sub + 2 CTAs + demo widget
3. Logo wall ("Trusted by") + G2/badges
4. Metric bar (calls, uptime, latency, ROI)
5. Live demo (3 patterns — see below)
6. How it works (3-4 steps) + platform screenshots
7. Use cases by industry (tabs) + integrations wall (CRM/telephony/calendar)
8. Case studies with $/% metrics + quotes
9. Security/compliance block (SOC 2, HIPAA, GDPR, PCI)
10. FAQ (objection handling) + final demo CTA + fat footer

Demo patterns: (a) browser call — Vapi, 11x, Voni; (b) call-me-back "enter your number" — Retell, Structurely, Regal; (c) dial-a-number "1-844-HEY-VAPI / 212-500-6000" — Vapi, Regal.

---

## 1. Bland AI — bland.ai

**Hero:** "Voice AI for regulated industries including healthcare, insurance, financial services, and logistics."
**Sub:** "Built for high-stakes phone calls where security and trust actually matter."
**CTAs:** "Book a call" / "Try for free" / "Log in"

**Sections in order:**
Hero + talk-to-agent widget (4 vertical agents: Bland / Healthcare / Insurance / Financial services — click-to-speak) → "680,526,010 calls resolved to date" → "Trusted by the world's most security-conscious enterprises" logo wall (Kin, Mutual of Omaha, TravelPerk, Corgi, EvenUp, Medallion, Innovaccer, Nuitée, First Financial, Signant) → "One platform. Every call." (Infrastructure/Reliability "no third parties" → Build "Tell Norm what you want" no-code → Test "1,003 scenarios" → Rollout/Omnichannel Voice+SNS+iMessage+Web Chat with unified memory → Observability "watch calls in real time" → Integrations grid) → Latency block "400ms vs 1240ms industry average" → "Real customers. Real revenue." (MyPlanAdvocate "$40M added in five months", American Way Health "$430M+ additional annual revenue", IHFA "$750K saved by retiring the IVR") → "Enterprise deployments, live in production in 30 days" timeline (Day 01 Discovery → 07 Build → 14 First run → 21 Dry run + safety locks → 30 Live) → "Built for complex, regulated industries" (SOC 2 Type II, HIPAA, PCI DSS v4.0, FedRAMP, AES-256, data residency, RBAC, 24/7 incident response) → "How people use Bland" SEO grid (IVR replacement, AI call center, inbound/outbound agents, call intelligence) → FAQ → "Secure voice AI that pays for itself" CTA.

**Proof:** call counter; named revenue metrics; 10 enterprise logos.
**Pricing:** "One per-minute rate covers LLM + STT + TTS + telephony. No per-token charges." Enterprise contracted by volume. Details on /pricing.

**Voni takeaway:** Steal the 30-day deploy timeline + "dry run + safety locks" language — maps 1:1 to Voni dry-run dialer + review-before-save. Steal vertical agent picker in hero demo.

---

## 2. Vapi — vapi.ai

**Hero:** "Voice agents for builders"
**Sub:** "Your agents, your rules. Build, deploy, and improve voice agents as fast as you ship."
**CTAs:** "Get started" / "Contact sales"

**Sections in order:**
Hero + Start-call widget (tabs: Customer Support / Lead Qualification / Appointment Scheduling) → Ring quote ("zero to production in two weeks, 100% of inbound volume through Vapi, CSAT improved" — Jason Mitura, VP Software Development) → "Trusted at enterprise scale" (Ring, Intuit, ServiceTitan, New York Life) → "One platform for all your voice agents" (Build/test/deploy in minutes; Ship better agents with monitoring) → "Hear for yourself 1-844-HEY-VAPI" → "API-native by design" integration wall (OpenAI, Anthropic, ElevenLabs, Deepgram, Cartesia, AssemblyAI, PlayHT, Azure, Gemini, Groq, Twilio, Telnyx, Salesforce, HubSpot, GoHighLevel, etc.) → "Enterprise-ready capabilities" (SLA, dedicated deployment engineer "live in a week", SSO/OAuth/RBAC, sub-500ms scale to millions, AI guardrails, SOC 2/HIPAA/PCI) → Kavak + GoHealth + Instawork case cards ("5X revenue growth, 250k monthly calls", "1M+ calls per month") → Stats bar (1B calls, 99.9% uptime, 2.5M+ agents, 1M+ developers, <500ms latency) → VapiCon summit CTA.

**Proof:** Ring/Kavak named quotes; 1B-calls stats bar.
**Pricing:** not on landing; /pricing page.

**Voni takeaway:** Voni already copies Vapi's in-browser mic + scenario + one-click pattern (`landing-demo.tsx`). Add Vapi's second move: a dial-in phone number demo for visitors without mics. Add an integrations wall (AssemblyAI, Telnyx, HubSpot, Salesforce, Cal.com) — Voni has all of these but shows none.

---

## 3. Retell AI — retellai.com

**Hero:** "#1 AI Voice Agent Platform for Automating PHONE Calls" / "Meet your AI call center from the future."
**Sub:** "Build, deploy, and manage next-generation AI voice agents that sound human, execute tasks, and scale effortlessly."
**CTAs:** "Try Our Live Demo" / "Try For Free" / "Contact Sales"

**Sections in order:**
Hero + G2 badges + logo wall → "Try Our Live Demo — Receive a live call from our agent" (pick use case: Receptionist / Appointment Setter / Lead Qualification / Customer Service / Debt Collection / Survey → enter Name + Phone → "Get a call") → "Proven Impact, Real Conversations" (Pine Park Health "scheduling NPS +38%", SWTCH "support costs -50%", Medical Data Systems "~$280,000 per month, 100% inbound with 30% transfer") → "Production-Ready AI Agent Platform Your Team Can Operate" (Build visual canvas → Test simulate thousands + regression → Deploy inbound/outbound/web/SMS → QA 100% of calls → Custom Analytics + A/B) → "Human-standard AI voice agent, out of the box" (Lowest latency ~600ms benchmarked; Ultra realistic voice; Turn-taking model) → "Built for the Complexity of Real Call Centers" (Agentic human handoffs with brief; Outbound campaigns with pacing/retries/voicemail; Navigate IVRs + DTMF; Listen live + take over; CRM context in/out) → Omnichannel (Voice / Chat / SMS / API) → "Enterprise-Grade Security" (HIPAA, SOC 2 Type II, GDPR, ISO 27001, PII redacting, RBAC, on-prem, FDE implementation) → Developer friendly (always best models, APIs/SDKs, out-of-box integrations) → FAQ (12 Qs incl. "Can AI replace call center agents? No — hybrid model", "$10 free usage", "connect existing number via SIP") → "Revolutionize your call operation" CTA.

**Proof:** 3 metric case studies with named people; benchmark claim (~600ms).
**Pricing:** /pricing page; "$10 free usage" in FAQ.

**Voni takeaway:** Steal the "call-me-back" demo as a second demo mode for phone-first visitors (Voni only has browser call). Steal "Listen live, step in when needed" + "Agentic human handoffs with brief" — Voni's handoff story in their words. Steal VS-pages footer (VS Bland/Vapi/Synthflow) for SEO later.

---

## 4. Synthflow AI — synthflow.ai

**Hero:** "Enterprise-Ready Voice AI Agents for Automated Phone Calls"
**Sub:** "The only end-to-end Voice AI platform with in-house telephony, proven deployment framework, and ROI delivered in weeks"
**CTAs:** "Get a demo"

**Sections in order:**
Hero + analyst report card → Stats bar (65M+ calls, 4M+ hours saved, +35% answered calls, 99.99% uptime; hero logos YMCA, Freshworks, Thryv) → "Deploy Voice AI Without the Risks — The Synthflow BELL Framework" (01 Build visual Flow Designer → 02 Evaluate Test Center simulated calls vs KPIs → 03 Launch own telephony network → 04 Learn Auto-QA + monitoring feedback loop) → "The Complete Voice AI OS" (Multi-Agent subflows, Custom telephony sub-100ms latency, AI Sandbox versioning/rollback, Real-Time Monitoring, Data Fine-Tuning) → "One Agent for Every Conversation" omnichannel (voice/chat/SMS) → "Own the Network, Control the Call" (regional infra, BYOC/SIP, Cisco/Avaya/Genesys/RingCentral fit; <100ms, 99.99%) → "Production-Ready AI Voice Agents for Every Industry" with Hear Demo per card — Real Estate card: "Answer property inquiries, qualify leads, and schedule viewings instantly to accelerate deal service — even after hours" → "Why Leading Teams Choose Synthflow" (ROI in 60 days via Forward-Deployed Engineers; SOC 2/HIPAA/PCI/GDPR; reliability; CX; brand-safe no-hallucination logic) → "200+ Integrations" → ROI case carousel (Freshworks "65% routine calls automated, -75% wait", Medbelle "+60% scheduling efficiency, 2.5x appointments, -30% no-shows", BPO "600K+ calls/mo, 40+ agents, 60 days, 0 hires", CRM "500K calls/mo white-labeled", Smartcat "-70% booking cost, +15% closed sales") → "Ready to Scope Enterprise Voice AI?" (volume/integrations/security/launch) → FAQ (free build + PAYG calls only; "doesn't replace your team — overflow + after-hours + handoff"; off-brand tone controls; stuck → clarify/escalate).

**Proof:** 6 ROI case cards with % metrics; G2 Leader badges.
**Pricing:** "Build free, PAYG — only pay for actual calls/chats."

**Voni takeaway:** Closest structural model for Voni. BELL (Build→Evaluate→Launch→Learn) = Voni wizard → dry-run → live → call history/jobs. Steal Real Estate card copy verbatim angle for property proof vertical. Steal "ROI in 60 days / weeks not months" framing + FAQ objection answers (replace team? off-brand? stuck?).

---

## 5. Thoughtly — thoughtly.com (substituted for air.ai)

**Hero:** "Voice AI for the leads you can't miss."
**Sub:** "CRM-driven AI voice agents that call your leads — then text, follow up, and stay on every channel until they pick up."
**CTAs:** "Request a Demo" / "Get Started"

**Sections in order:**
Hero ("#1 voice AI for GTM teams", G2 4.6) → logo wall (2U, Ace Hardware, Farmers Insurance, Siemens, Rothschild, edX, Nomad) → customer story cards (Nomad "20,000 calls a day without adding a rep", Podium Education "100% of opportunities", Centracom "cut costs nearly $500k", Cleveland Auto "400% more appointments") → "Sounds human. Converts like your best rep." 4-channel demo (01 Voice: branded caller ID verified iOS/Android "lock screen not spam" + mortgage form mock; 02 Text: "calls convert 3x — works iMessage/SMS/WhatsApp until they pick up"; 03 Email: same agent same name/brand/voice across dial/text/inbox; 04 CRM: instant write-back to Salesforce/HubSpot "reps inherit pipeline, not paperwork") → Timeline story "Sofia Ramirez" (8:57am lead lands in Salesforce → 8:57 dialed 10s after form → 9:02 answered-driving pivoted to SMS → 9:16 picked 6pm callback → 6:18 quoted/bound — "One lead. One agent. Zero human hours.") → Funnel stats (100% lead coverage, 10s speed-to-lead, 24/7) → "Every call tracked" dashboard (live call feed 1,284 calls, auto-classification Booked/Qualified/Voicemail/DNQ, weekly pipeline $186K +18%, 42 meetings 12 closed $4.4K avg) → Nomad + Podium quotes → "Put your revenue on autopilot" CTA.

**Proof:** 4 story cards + live-feed dashboard mock with numbers; G2 4.6.
**Pricing:** /pricing page, not inline.

**Voni takeaway:** Best single model for Voni's loop (agents → calls → campaigns → customers). Steal: 10-second speed-to-lead claim structure, "one agent every channel (voice→SMS/WhatsApp→email→CRM)", Sofia-style timeline (lead → dial → SMS pivot → callback → booked), and live-feed dashboard as the campaigns/calls page aspiration. WhatsApp explicitly in the channel story — most competitors omit it; Voni should headline it.

---

## 6. 11x — 11x.ai

**Hero:** "Digital Workers, Human Results" / "Trusted by leading Sales, RevOps, and Marketing teams"
**Sub (Alice):** "Alice turns your market into revenue. She engages prospects across channels, handles replies, drives qualified meetings and builds pipeline."
**CTAs:** "Get a Live Demo" / "Try Julian live" / "Hire Alice" / "Hire Julian"

**Sections in order:**
Hero + mini chat demo → logo wall (Rogo, Rillet, Groupe Santiane, Mapped, Lab Group, Ornn, Brainsuite, Buildwitt, Workera, Leica, Checkr…) + quote carousel ("cut monotonous cadences dramatically", "one hour vs 30+ hours, 10-15 calls booked same week", "9.7% reply rate nearly double industry avg", "5x qualified meetings", "40 BDRs in one click") → "Meet Julian — The most realistic AI phone agent you've heard" live browser call (scenario: Receptionist / Speed-to-Lead / Account Expansion + voice: Energetic/Confident/Supportive/Professional/Gentle/Down to Earth/British → Talk to Julian → live transcript + "Put Julian on your calls" lead form) → "Meet Alice — Julian's counterpart on outbound" (autopilot email mock) → "Digital workers transform your workforce" (Always learning, Customised memory, Deeply integrated, Autonomous, Enterprise-ready SOC-2) → Ticker ("Decrease costs per lead, Boost revenue, Increase pipeline, Lead qualification on autopilot…") → "From prospecting to closing: All-in-one" platform (Identify 50+ signals → Research auto-enrich → Personalize no templates → Engage email/phone/chat/social/SMS/WhatsApp with screenshots + campaign dashboard) → "Pipeline from leads you'd written off" (1.5x meetings, $1M+ pipeline in 3 months, 35% of pipeline by 11x) → "Hire our Digital Workers" CTA with astronaut image.

**Proof:** 10+ named quotes with titles; pipeline $ metrics.
**Pricing:** demo-gated, not inline.

**Voni takeaway:** "Digital Workers, Human Results" is the same idea as Voni's "AI employee with a mission, not another chatbot" — study how 11x names workers (Alice/Julian), gives them faces, and says "Hire" instead of "Sign up". Steal scenario+voice picker for the demo widget. "$70M+ raised from a16z and Benchmark" top bar = funding-as-proof pattern (skip for Voni — no claim to make).

---

## 7. Conversica — conversica.com

**Hero:** "Start a Conversation With Your Customers" / "Conversica's AI Agents help you start effortless conversations that build trust, deepen relationships, and drive growth."
**Second head:** "Make Every Customer Experience a Conversation" / "Stop blasting messages into the void. Start real conversations that generate demand, solve problems, and build lasting relationships."
**CTAs:** "Get Started" (repeated 8+ times) / "Log In"

**Sections in order:**
Hero + logo wall (Iron Mountain, Epsom, Hendrick Auto, IHS Markit, Hootsuite, Red Sox, ServiceNow, T-Mobile, Knicks, Jets…) → 3 pillars each as Challenge→Solution→Use-cases: (1) Generate Demand & Acquire (Events/Ads/Content/ABM/Inbound — "without real conversations, interest fades and pipeline stalls" → "persistent, personalized conversations"); (2) Deliver Exceptional Service (answer instantly, update plans/payments in-conversation, manage pauses/billing, escalate without breaking); (3) Keep Customers Coming Back (renewals, upsell, re-engage inactive) → $500K-deal quote (John Hansen, Sr Director Field Marketing: "customer responded Friday of Labor Day weekend… AI Agent was there… by Friday we had a $500,000 deal") → "Trusted By" stats ("1.5 Billion Conversations for 2,000+ Teams") + 6 cards (qualify/re-engage/resolve; industry-trained brand-safe; deeply integrated take-action; 24/7 multichannel multilingual; enterprise security GDPR/SOC 2; proven flows tuned for conversion) → Deep dive Generate Demand with screenshots (Events/Ads/Content/Outbound/Nurture) → "Your 3-Step Plan" (01 Meet with our team → 02 Build Your AI Agent (industry flows + integrations) → 03 Start Seeing Results in Days) — printed twice → logo wall again → "Schedule A Demo".

**Proof:** 1.5B conversations / 2,000+ teams; single big-deal story.
**Pricing:** gated (/request-a-demo, /category/plans).

**Voni takeaway:** Best persistent-follow-up copy ("every lead worked", "interest fades without conversations", "responds Labor Day Friday"). Steal Challenge→Solution→Use-cases triple and the 3-step plan (maps to Voni: define outcome → wizard builds → campaigns run). Most email/SMS/chat-heavy of the 10 — Voni differentiates by leading with voice calls.

---

## 8. Slang.ai — slang.ai

**Eyebrow:** "#1 VOICE AI TOOL FOR RESTAURANTS"
**Hero:** "The AI Superhost for Restaurants"
**Sub:** "Slang AI answers every inbound call, instantly responds to guest inquiries, and automatically manages reservations – 24/7."
**CTAs:** "Try Slang AI"

**Sections in order:**
Hero → 3 value props (Boost Revenue "up to 50% more phone covers" / Maximize Staff Efficiency "save 200+ hours monthly" / Effortless Setup "30 mins, 20x ROI") → logo wall (Merchants, Texas de Brazil, Genuine Hospitality, Culture Collective, Fireman, DineAmic, Carmine's, Burgatory…) → "Why Slang AI?" (Cross-Sell across locations when full; VIP Call Routing to staff/concierge; Smart Alerts for private dining/complaints/lost items; 5-Star experience "only platform that measures CSAT, 96%+") → "Best-in-class integrations" (OpenTable, SevenRooms, Tripleseat, Yelp) → "How Slang AI works" 3 bubbles (Incoming Call "reservation for 8 Saturday?" → Slang picks up "7:30pm work?" → Staff gets update "Group of 8 confirmed") → "Get set up in as little as 30 minutes" (Schedule demo → Seamless integration → Never miss a call) → Testimonials (7 quotes: "communication increased exponentially", "hang-ups no longer a problem", "96% satisfaction 90 days", "100+ hours/month", "700 voicemails → don't worry", "staff would boycott if we stopped") → FAQ (50% more reservations / 96% CSAT / 200h / 10x ROI; <30 min setup same-day live; premium voices+accents; unlimited concurrent; OpenTable; analytics covers/peak/CSAT; keep number via onboarding; latency/prosody/timbre/fluency; fallback forwards to human or texts) → "Join thousands of restaurant operators" CTA.

**Proof:** 96% CSAT + Fast Company Most Innovative 2024; 7 operator quotes with names/titles.
**Pricing:** /pricing page.

**Voni takeaway:** Best SMB-vertical template. "AI Superhost" → Voni property angle "AI Leasing Agent". Steal 3-bubble call flow (caller → AI → staff update), VIP-routing + smart-alerts as handoff features, and fallback FAQ ("forwards to human or texts"). 30-minute setup claim structure (Voni: wizard time-to-first-agent).

---

## 9. Structurely — structurely.com

**Hero:** "All your customer conversations Handled by AI"
**Sub:** "Inbound. Outbound. Sales. Support. Customer success. Structurely brings every customer conversation across voice, SMS and email onto one AI-native telephony and voice orchestration platform."
**CTAs:** "Try the AI" / "See how It Works" / "GET A LIVE DEMO CALL — Enter your number"

**Sections in order:**
Hero + phone mock → "Voted #1 Conversational AI platform in US by AI Magazine" + logo wall (Rocket, Mutual of Omaha, Lower.com, Twilio, Sierra Interactive, Salesforce, AVFlight, Ethos) → "Let AI handle the conversations. Your team handles the outcomes." + audio player + stats (years, M+ human fine-tuned conversations, Positive Outcome Rate, contact-center years, % auto-dispositioned, conversion lift) → "One conversational AI platform. Out of the box. Go headless. Or anywhere in between." (portal screenshots + CRM logos: Bonzo, Follow Up Boss, BoomTown, Salesforce, MarketSharp) → "Scale conversations without scaling headcount" (67% cost reduction; 21x more conversations; 24/7 never cold) → "How it works" 4 steps (Connect capture inbound/maximize outbound contact → Converse sell/answer/objections/follow-up/docs/upsell → Take Action book/schedule/transfer/workflows/transcribe/next-best-action → Sync auto-disposition + CRM update + trigger workflows) → "Powerful AI tools for every interaction" grid (Inbound/Outbound Voice, Two-Way SMS, Email Follow-Up, Appointment/Callback Scheduling, Live Transfers, FAQ, Document Collection, Auto CRM Updates, Dispositions, Cross/Upsell) → Use cases tabs (Mortgage: "Engage borrowers, qualify, answer, collect documents, schedule callbacks, transfer to loan officers" / Real Estate / Private Aviation / Home Services / White Label CRMs / Marketing Agencies) → "Grow your revenue with Structurely" CTA.

**Proof:** award badge; CRM logo wall; stat block (JS-rendered numbers didn't extract — verify live before citing).
**Pricing:** /pricing page.

**Voni takeaway:** Most direct property-vertical wording to study. Connect→Converse→Take Action→Sync maps to Voni agents→calls→campaigns→customers. Note the demo tradeoff they chose (call-me-back) vs Voni's browser call — consider offering both.

---

## 10. Regal.io — regal.io

**Hero:** "BUILT FOR CX LEADERS BY CX LEADERS" / "Regal helps businesses build, improve, and manage voice AI Agents. Built by contact center operators."
**CTAs:** "Request demo" / "Get a Call" (with TCPA consent copy) / "Call our AI (212) 500-6000"

**Sections in order:**
Hero + get-a-call form (consent: "I agree to receive marketing calls and texts, including from pre-recorded/artificial voice… Consent not a condition… reply STOP") + G2 stars → "Trusted by Leading Enterprises" logo wall (Toyota, eHealth, TaskUs, Kin, Varsity Tutors, American Red Cross, American Standard, AAA, Westgate, Figure, Mutual of Omaha, Fidelity Life, Guitar Center, General Assembly, Ethos…) → 4 metrics (97% containment, 80% cost-to-serve reduction, 0 sec answer, 4x speed-to-lead) → "The Regal Difference" (Sound Human low-latency 30+ languages; Contact Center Know-How; Complexity Handled in weeks; Better Lifetime Value) → "Voice AI in Action" 3 scenario cards each with Agent Goal + 96% satisfaction (Healthcare reschedule dentist; Financial qualify loans; Insurance qualify→licensed agent) → "Why Regal AI Agents Are Better" (Always Available 24/7 zero wait; AI Is Better 90%+ CSAT; Lower Cost) → "Designed for Every Customer Interaction" tabs (Support 97% containment; Lead Qualification "0 second answer, immediate Speed-To-Lead, convert at human rate, 2x business YoY"; Scheduling "no-shows halved, 80% savings"; Collections "$5B from 100MM+ consumers, higher rate than humans, CFPB-safe"; Bookings 97% containment) → "How Regal works" (Feels Human interrupt/change-topic; Make Your Own real-time data + drag-drop + native A/B testing; Operates Like Software scale on fly; Always Know live monitor + Conversation Intelligence auto-QA) → Platform 5 layers (Management / Orchestration / Safety privacy+hallucination+escalation / Business Context / Infrastructure multi-model multi-cloud) → "A dedicated team that builds with you" Forward-Deployed Engineer cards (Adam/Sean/Rukmani/Evi/Jordan with recent highlights) → "40+ integrations" → "Enterprise-Grade Security" (SOC 2, GDPR, CCPA, HIPAA; "LLM partners don't train on your data") → Customer stories (Embrace, a360inc, Fair Financial 2x conversions) → "Treat your customers like royalty" demo CTA.

**Proof:** 20+ enterprise logos; containment/CSAT/cost metrics; $5B collections figure.
**Pricing:** /pricing page.

**Voni takeaway:** Best compliance/safety template: TCPA consent wording, Branded Caller ID + Spam Remediation pages, Safety Layer (privacy/hallucination/escalation), "LLMs don't train on your data". Steal A/B testing + auto-QA + live monitoring as the jobs/calls-page aspiration. "Built by contact center operators" → Voni equivalent: built for operators/teams who live on the phone.

---

## Cross-cutting copy moves worth stealing
- Headline formula: outcome + human frame. ("Digital Workers, Human Results" / "Your team handles the outcomes" / "Converts like your best rep" / "Never miss a call again".) Voni's "AI employee with a mission, not another chatbot" already plays here — keep it, add an outcome second line ("qualifies leads, books viewings, follows up 24/7").
- Speed-to-lead as seconds: 10s (Thoughtly), 0 sec (Regal), 60-sec window, "Labor Day Friday" story (Conversica). Voni campaigns page should show response-time stat.
- "Every lead" language: "every lead worked / every lead, every channel, all the time / 100% of inbound / no lead goes cold / pipeline from leads you'd written off".
- 3-step plans everywhere: BELL (Synthflow), Connect→Converse→Take Action→Sync (Structurely), Meet→Build→Results in Days (Conversica), Identify→Research→Personalize→Engage (11x). Voni's: Describe outcome → Wizard builds agent → Campaigns call + follow up → Customers.
- Trust order: logos → metrics → case $/% → compliance badges → FAQ objections (replace team? off-brand? stuck? keep number? train on data?).
- WhatsApp is rare on these pages (Thoughtly names it; Bland/Synthflow say SMS/iMessage/chat). Voni's phone+WhatsApp memory is a differentiator — headline it.
- Demo CTA ladder: browser call (lowest friction) → call-me-back (phone-first) → book demo (enterprise). Voni has #1; add #2 (Retell/Structurely pattern) before building #3.
- Objection FAQs to copy: setup time (30 min / weeks), replaces team? (overflow+after-hours+handoff), off-brand? (tone + escalation rules), stuck? (clarify/escalate/human brief), number? (SIP/BYOC/keep), compliance? (SOC2/HIPAA/GDPR/TCPA + no training on data).
