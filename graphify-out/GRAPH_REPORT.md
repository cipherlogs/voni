# Graph Report - .  (2026-09-20)

## Corpus Check
- Large corpus: 520 files · ~380,979 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 2728 nodes · 6772 edges · 182 communities (140 shown, 42 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 170 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Copilot Element Catalog
- Scratch Specs Backlog
- Shared UI Components
- Campaign Dialer Engine
- Leads Task Board
- App Shell Auth
- Agent Wizard Draft
- Voni Documentation Map
- Sidebar Navigation Shell
- Calls History List
- Copilot Proposal Bus
- Durable Jobs Core
- Route Loading Screens
- Settings Gallery Tiles
- Wizard Validation Logic
- Agent Config Form
- Guidance Docs Map
- Jobs API Routes
- Business Tools Runtime
- Route Error Screens
- Runtime Dependencies
- LLM Provider Chain
- Dashboard Copilot Shell
- Form UI Primitives
- Voice Persona Catalog
- Voice Session Streaming
- MCP Tool Config
- Leads Bulk Selection
- Record Search Jobs
- Settings Server Actions
- Chat Bubble UI
- Carousel Voice Picker
- Sheet Sidebar Primitives
- TypeScript Config
- Call Recording Store
- Custom Tool Compiler
- Telephony Media Server
- Job Start API
- Phone Number Binding
- Copilot Context Provider
- Dev Dependencies
- Voice Session Client
- NPM Scripts
- Operator Credentials UI
- Job Dispatch Runtime
- Copilot Job Actions
- Auth DB Schema
- Campaign Runner Tests
- Credential Encryption
- Agent CRUD Actions
- Wizard Step UI
- Shadcn Components Config
- Detail Pages
- Lead CSV Import
- Bridge Auth Secrets
- Edit Draft Cache
- Root Layout Toast
- Command Menu UI
- Proposal Executors
- Job Schema Contracts
- Telephony Tool Coordinator
- E2E Runner Script
- Integration Health Probes
- Campaign Form UI
- Worker Queue Consumer
- Lead Detail Page
- Onboarding Pipeline UI
- Bridge Config Client
- App Manifest Generator
- Avatar Mascot UI
- Agent Provisioning API
- Table Dropdown UI
- Jobs Watch List
- Provider Tool Catalog
- Tool Coordinator Tests
- Voice Preview API
- App Guide Navigation
- Voice QA Script
- Delete Race Verifier
- Rate Limit Tokens
- Leads List Rows
- Job Row UI
- Jobs Toast Provider
- Copilot Voice Prefs
- Tag Field Logic
- Live Jobs Refresh
- TS Tool Coordinator
- Tool Call Lifecycle
- Brand SVG Kit
- Agent Status Entries
- Streaming Concepts
- Campaign Dispatch Client
- Avatar OG Images
- Brand PNG Kit
- Calls Index Test
- Retry Card Test
- Toggle Group UI
- LLM Gateway Concepts
- Dictation Sync SDKs
- Boilerplate Icon Set
- Press Raster Script
- Leads Filters Test
- Wizard Timeline Test
- Campaign Queue Test
- Tabs UI
- Mic Ownership Lock
- Cloudflare Worker Entry
- Async STT API
- Manual Call Placer
- Session Audio Puller
- Wordmark Shots Script
- Delete Button Test
- Page Gate Test
- Queue Bulk Actions
- Onboarding Statusline UI
- Marker UI
- Unsaved Pill Test
- LLM Gateway Auth
- Voice Agent Lifecycle
- Universal Models
- Dev Loop Skill
- Graphify Plugin Config
- Root Package Config
- Instant Nav Rig
- Package Metadata
- PCM Audio Processor
- Property Seed Script
- Calls Pagination Test
- Lead State Cell Test
- Wizard Reset Test
- Onboarding 07 Test
- Phone Labels Test
- Audio Intel Features
- JS SDK Clients
- Python SDK Clients
- Speech Understanding Ops
- Graphify Plugin Code
- App Icon Set
- Delete Action Test
- Filter Chips Test
- Short-Form Endpoints
- Stored Agents API
- Dictation Latency Tricks
- LLM Tool Calling
- Transcript Summarization
- LiveKit Pipecat Pair
- SDK Version Pair
- Realtime Voice APIs
- CI Verify Workflow
- Better Auth Dependency
- CVA Dependency
- Embla Carousel Dependency
- Neon Serverless Dependency
- Next.js Dependency
- OpenNext Cloudflare Dependency
- React DOM Dependency
- React Icons Dependency
- Shadcn React Dependency
- TanStack Table Dependency
- Place Call Script
- ESLint Config
- Next.js Config
- Drizzle ORM Dependency
- PostCSS Config
- Car Dealership Persona
- Dental Persona
- Avatar Placeholder Strategy
- Real Estate Persona
- Reception Persona
- Restaurant Persona
- Recent Route Test
- Placeholder Action Test
- Jobs Provider Test
- Audio Base64 Ingest
- Auth Session Hooks

## God Nodes (most connected - your core abstractions)
1. `cn()` - 285 edges
2. `Button()` - 55 edges
3. `db` - 38 edges
4. `VoiceSession` - 34 edges
5. `requireCtx()` - 33 edges
6. `requireCtxOrRedirect()` - 31 edges
7. `secret()` - 30 edges
8. `Badge()` - 29 edges
9. `ProposalStore` - 28 edges
10. `getCtx()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `Leadcalls Agent Routing Index` --semantically_similar_to--> `Claude Agent Routing Index`  [INFERRED] [semantically similar]
  AGENTS.md → CLAUDE.md
- `Responsive Async Work Protocol` --semantically_similar_to--> `Durable Job System`  [INFERRED] [semantically similar]
  docs/agents/async-work.md → PRODUCT.md
- `Safe Execution Path (Propose to Reconcile)` --semantically_similar_to--> `Confirmation and Independent Assent Protocol`  [INFERRED] [semantically similar]
  voni/docs/voni-strategy.pdf → voni/docs/copilot-coverage.md
- `BentoTile Settings Gallery` --conceptually_related_to--> `Voni Stack Notes`  [AMBIGUOUS]
  HANDOFF.md → docs/agents/nextjs.md
- `Voni Next.js App` --conceptually_related_to--> `Voni AI Employee`  [INFERRED]
  README.md → PRODUCT.md

## Import Cycles
- 4-file cycle: `voni/src/components/app-sidebar.tsx -> voni/src/components/sidebar-03/app-sidebar.tsx -> voni/src/components/sidebar-03/utility-rows.tsx -> voni/src/components/command-menu-03/command-menu-03.tsx -> voni/src/components/app-sidebar.tsx`

## Hyperedges (group relationships)
- **Short-Form API Selection** — _agents_skills_assemblyai_skill_sync_stt_api, _agents_skills_assemblyai_skill_dictation_api, _agents_skills_assemblyai_skill_streaming_v3 [EXTRACTED 1.00]
- **Speech Understanding Request Wrapper** — _agents_skills_assemblyai_references_speech_understanding_translation, _agents_skills_assemblyai_references_speech_understanding_speaker_identification, _agents_skills_assemblyai_references_speech_understanding_custom_formatting, _agents_skills_assemblyai_references_speech_understanding_summarization, _agents_skills_assemblyai_references_speech_understanding_action_items [EXTRACTED 1.00]
- **Voice Agent Integration Paths** — _agents_skills_assemblyai_references_voice_agents_livekit, _agents_skills_assemblyai_references_voice_agents_pipecat, _agents_skills_assemblyai_references_voice_agents_session_lifecycle [EXTRACTED 1.00]
- **Settings Bento Registry to Landing Flow** — _scratch_settings_bento_issues_01_registry_and_gallery_tile_registry, _scratch_settings_bento_issues_02_landing_and_shell_registry_driven_landing, _scratch_settings_bento_issues_02_landing_and_shell_dynamic_section_shell, _scratch_settings_bento_issues_04_badges_and_conditional_tiles_live_badges [INFERRED 0.85]
- **Sidebar-03 Floating Shell Adoption Flow** — _scratch_sidebar_03_brand_swap_issues_01_floating_shell_workspace_nav_floating_shell, _scratch_sidebar_03_brand_swap_issues_02_four_state_brand_swap_four_state_brand, _scratch_sidebar_03_brand_swap_issues_03_footer_jobs_session_single_workspace_footer, _scratch_sidebar_03_brand_swap_issues_06_top_bar_removal_top_bar_removal [INFERRED 0.85]
- **Button Cursor and Draft Parity Fix** — _scratch_button_cursor_draft_gate_issues_01_native_arrow_cursor_on_shared_button_shared_button_native_arrow_cursor, _scratch_button_cursor_draft_gate_spec_shared_button_style_definition, _scratch_button_cursor_draft_gate_issues_02_equal_weight_discard_action_on_draft_prompt_equal_weight_actions, _scratch_button_cursor_draft_gate_spec_outlined_discard_swap [INFERRED 0.85]
- **Async Durable Verification Loop** — docs_agents_async_work_async_protocol, product_durable_job_system, docs_agents_nextjs_next_dev_loop [INFERRED 0.75]
- **Seven Fixes Plan Spec Build** — docs_superpowers_plans_2026_09_08_agent_ux_seven_fixes_seven_fixes_plan, docs_superpowers_specs_2026_09_08_agent_ux_seven_fixes_design_seven_fixes_spec, docs_superpowers_plans_2026_09_08_agent_ux_seven_fixes_backlink_component [EXTRACTED 1.00]
- **Voni Product Loop** — product_voni_ai_employee, product_conversion_loop, product_voice_copilot, readme_voni_app [INFERRED 0.85]
- **Durable Jobs Cross-System Pattern** — voni_agents_durable_job_system, voni_environment_background_jobs_infra, voni_docs_copilot_coverage_record_search_job [INFERRED 0.85]
- **Voice Safety Confirmation Pattern** — voni_docs_voni_strategy_safe_execution_path, voni_docs_copilot_coverage_confirmation_assent_protocol, voni_agents_visual_feedback_protocol [INFERRED 0.75]
- **Design System Compliance Triad** — voni_design_component_vocabulary_contract, voni_docs_shadcn_audit_base_nova_audit, voni_design_prohibited_drift_definition_of_done [INFERRED 0.85]
- **Next.js Default 16px Gray UI Icons** — voni_public_file_icon, voni_public_globe_icon, voni_public_window_icon [INFERRED 0.85]
- **Voni Persona Vertical Photo Set** — voni_public_personas_car_dealership_photo, voni_public_personas_dental_photo, voni_public_personas_real_estate_photo, voni_public_personas_reception_photo, voni_public_personas_restaurant_photo [INFERRED 0.95]
- **Voni Avatar Size Variants (400/500/1024)** — voni_public_press_png_avatar_1024_image, voni_public_press_png_avatar_400_image, voni_public_press_png_avatar_500_image [INFERRED 0.95]
- **Voni press-kit PNG set sharing one arc-mark identity** — voni_public_press_png_voni_chip_light_1024_file, voni_public_press_png_voni_chip_light_512_file, voni_public_press_png_voni_mark_dark_1024_file, voni_public_press_png_voni_mark_light_1024_file, voni_public_press_png_voni_wordmark_dark_2048_file, voni_public_press_png_voni_wordmark_light_2048_file [INFERRED 0.95]
- **Shared resting-arc path motif across press kit** — voni_public_press_voni_chip_dark_file, voni_public_press_voni_chip_light_file, voni_public_press_voni_mark_dark_file, voni_public_press_voni_mark_light_file, voni_public_press_voni_mono_black_file, voni_public_press_voni_mono_white_file, voni_public_press_voni_wordmark_dark_file, voni_public_press_voni_wordmark_light_file [INFERRED 0.95]

## Communities (182 total, 42 thin omitted)

### Community 0 - "Copilot Element Catalog"
Cohesion: 0.08
Nodes (58): BusContext, BusToolResult, buildCatalog(), CatalogElement, CatalogInput, catalogPage(), CatalogQuery, classifyControl() (+50 more)

### Community 1 - "Scratch Specs Backlog"
Cohesion: 0.05
Nodes (63): Disabled Button Dimmed Affordance, 01 Native Arrow Cursor on Shared Button, Link and Disclosure Hand Pointer Exception, Shared Button Native Arrow Cursor, 02 Equal Weight Discard Action on Draft Prompt, Draft Resume Versus Clear Behavior, Draft Prompt Equal Weight Boxed Actions, Button Cursor Draft Gate Spec (+55 more)

### Community 2 - "Shared UI Components"
Cohesion: 0.05
Nodes (51): ConfigFormFooter(), Ai01(), ProgressIdiom(), ProgressIdiomProps, StatusBadge(), StatusBadge(), StatusBadge(), StatusBadge() (+43 more)

### Community 3 - "Campaign Dialer Engine"
Cohesion: 0.07
Nodes (47): insideWindow, leadIds, outsideWindow, window, POST(), schema, POST(), CampaignInput (+39 more)

### Community 4 - "Leads Task Board"
Cohesion: 0.10
Nodes (36): STATUS_VARIANT, Filter, LeadsSearchParams, LEAD_STATUS_LABEL, LEAD_STATUS_TONE, QueueMember, FilterChip, FilterChips() (+28 more)

### Community 5 - "App Shell Auth"
Cohesion: 0.07
Nodes (33): { GET, POST }, ShellAuthResolver(), LoginDecision(), OAUTH_ERRORS, LandingHeaderGate(), SignupDecision(), AuthForm(), AuthenticatedRedirect() (+25 more)

### Community 6 - "Agent Wizard Draft"
Cohesion: 0.09
Nodes (39): ensureGenerationPlaceholderAction(), getGenerationPlaceholderAction(), flattenResolved(), NewAgentInner(), composeBrief(), generationIdempotencyKey(), GOAL_SUGGESTIONS, languageLabel() (+31 more)

### Community 7 - "Voni Documentation Map"
Cohesion: 0.05
Nodes (44): Durable Job System (src/lib/jobs), JobCenter Global Status Indicator, LoadingButton Pending Pattern, Per-Item Pending State Pattern, Responsive Async Work Protocol, Route loading.tsx and error.tsx Contract, Visual Feedback Protocol, Claude Agent Entrypoint (@AGENTS.md) (+36 more)

### Community 8 - "Sidebar Navigation Shell"
Cohesion: 0.08
Nodes (32): AppSidebar(), SidebarStateRestore(), toRoutes(), BARS, VoiceBars(), VoiceBarsMood, DashboardSidebarShell(), SidebarBrandHeader() (+24 more)

### Community 9 - "Calls History List"
Cohesion: 0.12
Nodes (32): GET(), absoluteCallTime(), callsChips(), callsPageHref(), CallsRows(), CallsSearchParams, DashboardSummary, getDashboardSummary() (+24 more)

### Community 10 - "Copilot Proposal Bus"
Cohesion: 0.11
Nodes (5): CopilotBus, targetKey(), makeHarness(), ProposalStore, harness()

### Community 11 - "Durable Jobs Core"
Cohesion: 0.13
Nodes (30): generateAgentConfig(), JobInput, CancelledJobError, errorCodeFor(), handlerFor(), isJobQueued(), isTransientJobError(), JOB_LEASE_MS (+22 more)

### Community 12 - "Route Loading Screens"
Cohesion: 0.08
Nodes (9): CARD_META_WIDTHS, CARD_TITLE_WIDTHS, CardListSkeleton(), DetailSkeleton(), NewAgentSkeleton(), PageHeaderSkeleton(), SHIMMER_DELAYS, StatGridSkeleton() (+1 more)

### Community 13 - "Settings Gallery Tiles"
Cohesion: 0.09
Nodes (29): metadata, ORDER, CalendarMark(), DriveMark(), GmailMark(), NotionMark(), SlackMark(), ConstellationScene() (+21 more)

### Community 14 - "Wizard Validation Logic"
Cohesion: 0.11
Nodes (34): caseInsensitiveDupes(), CONVERSATION_LANGUAGES, conversationLanguageSchema, DEFAULT_WIZARD_VOICE_ID, defaultGreeting(), EMPTY_WIZARD_DRAFT, goalItem, LOCALIZED_GREETINGS (+26 more)

### Community 15 - "Agent Config Form"
Cohesion: 0.09
Nodes (23): AgentConfigForm(), CHANNEL_META, PACE_ITEMS, ProviderToolPicker(), INITIAL, PROVIDER_ICONS, ProviderCard(), SettingsSection() (+15 more)

### Community 16 - "Guidance Docs Map"
Cohesion: 0.08
Nodes (35): Leadcalls Agent Routing Index, Claude Agent Routing Index, AssemblyAI Agent Instructions, AssemblyAI Guidance, Responsive Async Work Protocol, Durable Background Work, Architecture Decision Records, CONTEXT.md Glossary (+27 more)

### Community 17 - "Jobs API Routes"
Cohesion: 0.15
Nodes (28): ACTIONS, GET(), POST(), POST(), BulkJobFailure, bulkJobsAction(), BulkJobsResult, bulkSchema (+20 more)

### Community 18 - "Business Tools Runtime"
Cohesion: 0.14
Nodes (31): schedule, jsonError(), POST(), requestSchema, appointments, followUps, properties, toolCallLogs (+23 more)

### Community 20 - "Runtime Dependencies"
Cohesion: 0.06
Nodes (33): ai, @ai-sdk/openai, @base-ui/react, clsx, cmdk, cn, lucide-react, @neon/config (+25 more)

### Community 21 - "LLM Provider Chain"
Cohesion: 0.09
Nodes (25): Attempt, callMetaProvider(), callProvider(), DEFAULT_DEPENDENCIES, DEFAULTS, extractJson(), failureReason(), generateJSON() (+17 more)

### Community 22 - "Dashboard Copilot Shell"
Cohesion: 0.12
Nodes (20): DashboardOutcomes(), CopilotStatus, useCopilot(), CopilotShell(), formatElapsed(), STATUS_TEXT, features, Onboarding01() (+12 more)

### Community 23 - "Form UI Primitives"
Cohesion: 0.12
Nodes (19): Login01(), CREDENTIAL_LABELS, CREDENTIAL_SERVICES, INITIAL, PROVIDER_LABELS, Field(), FieldError(), FieldGroup() (+11 more)

### Community 24 - "Voice Persona Catalog"
Cohesion: 0.13
Nodes (25): INLINE_CAP_SECONDS, LANGUAGE_TABS, Mode, VoiceCall(), VoiceCallHandle, VoiceCallPending, VoiceCallStatus, voicesFor() (+17 more)

### Community 25 - "Voice Session Streaming"
Cohesion: 0.07
Nodes (24): AgentTurn, AudioProbeEvent, buildInlineSessionUpdate(), buildResumeMessage(), decideReconnectOnClose(), fromBase64(), QueuedUpdate, QueuedVoice (+16 more)

### Community 26 - "MCP Tool Config"
Cohesion: 0.06
Nodes (30): timeout, type, url, TELNYX_API_KEY, Authorization, mcp, assemblyai-docs, Neon (+22 more)

### Community 27 - "Leads Bulk Selection"
Cohesion: 0.13
Nodes (20): bulkLeadsStageAction(), LeadsSelectAll(), LeadsSelectCell(), LeadsSelection(), LeadsSelectionContext, RAW_STAGE_LABEL, RAW_STAGES, Selection (+12 more)

### Community 28 - "Record Search Jobs"
Cohesion: 0.12
Nodes (22): orgs, run, scope, users, RecordKind, recordMatchSchema, RecordSearchInput, recordSearchInputSchema (+14 more)

### Community 29 - "Settings Server Actions"
Cohesion: 0.12
Nodes (27): addLlmAccount(), ensurePrefsOwner(), nullable(), providerConnectionSchema, removeLlmAccount(), removePlatformCredential(), requireLlmProviderId(), setLlmAccountEnabled() (+19 more)

### Community 30 - "Chat Bubble UI"
Cohesion: 0.12
Nodes (25): Ai05(), Ai05Message, Ai05Props, Ai05Status, Chat01(), Chat01Turn, Bubble(), BubbleContent() (+17 more)

### Community 31 - "Carousel Voice Picker"
Cohesion: 0.10
Nodes (27): Carousel(), CarouselApi, CarouselContent(), CarouselContext, CarouselContextProps, CarouselItem(), CarouselNext(), CarouselOptions (+19 more)

### Community 32 - "Sheet Sidebar Primitives"
Cohesion: 0.09
Nodes (23): Sheet(), SheetContent(), SheetDescription(), SheetFooter(), SheetHeader(), SheetModalContext, SheetOverlay(), SheetTitle() (+15 more)

### Community 33 - "TypeScript Config"
Cohesion: 0.07
Nodes (28): dom, dom.iterable, esnext, **/*.mts, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules (+20 more)

### Community 34 - "Call Recording Store"
Cohesion: 0.08
Nodes (16): CallRecorder, normalize_phone(), Any, Persistence for the telephony bridge — Neon Postgres, via asyncpg. Until now…, Flush outstanding writes and close the pool. Never raises., Background writer. One statement at a time, order preserved., Hand a write to the background worker. Never blocks, never raises., Upsert the Lead by phone and open a `calls` row. Awaited (not enqueued) because… (+8 more)

### Community 35 - "Custom Tool Compiler"
Cohesion: 0.09
Nodes (26): sensitiveCaptureFields(), CHANNELS, CustomTool, customToolSchema, DetectField, detectFieldSchema, MAX_CONFIG_NAME_LENGTH, TOOL_NAMES (+18 more)

### Community 36 - "Telephony Media Server"
Cohesion: 0.11
Nodes (27): FastAPI, post, Request, agent_to_telnyx(), build_session_update(), hang_up(), lifespan(), media_stream() (+19 more)

### Community 37 - "Job Start API"
Cohesion: 0.19
Nodes (20): argsSchema, POST(), GET(), POST(), GET(), POST(), publicRecordResult, continueRecordSearch() (+12 more)

### Community 38 - "Phone Number Binding"
Cohesion: 0.15
Nodes (23): deleteAgentAction(), AgentDeleteButton(), addPhoneNumberAction(), bindPhoneNumberAction(), removePhoneNumberAction(), LoadingButton(), NumberRemoveButton(), PhoneNumber (+15 more)

### Community 39 - "Copilot Context Provider"
Cohesion: 0.13
Nodes (20): CaptionTurn, CopilotContext, CopilotContextValue, CopilotProvider(), copilotToken(), IDLE_MS, nextCaptionId(), ProposeChangeInput (+12 more)

### Community 40 - "Dev Dependencies"
Cohesion: 0.07
Nodes (27): drizzle-kit, eslint, eslint-config-next, @next/playwright, @playwright/test, sharp, tailwindcss, @tailwindcss/postcss (+19 more)

### Community 42 - "NPM Scripts"
Cohesion: 0.08
Nodes (26): scripts, build, copilot:manifest, copilot:manifest:check, db:generate, db:migrate, db:seed, db:studio (+18 more)

### Community 43 - "Operator Credentials UI"
Cohesion: 0.15
Nodes (18): getCopilotVoicePrefs(), SettingsData(), OperatorData, OperatorDenied(), credentialSummary(), maskCredential(), removeCredentialOverride(), listAccounts() (+10 more)

### Community 44 - "Job Dispatch Runtime"
Cohesion: 0.10
Nodes (15): DispatchResult, JobDispatcher, JobExecutor, JobMessage, StagedBlobStore, cloudflareJobDispatcher, CsvSource, dispatchWithRuntime() (+7 more)

### Community 45 - "Copilot Job Actions"
Cohesion: 0.12
Nodes (21): ExecutorFailure, actOnJob(), buildScheduleProposal(), executeCancelJob(), executeRetryJob(), executeScheduleJob(), JobAccept, jobIdArgs (+13 more)

### Community 46 - "Auth DB Schema"
Cohesion: 0.09
Nodes (23): account, accountRelations, invitation, invitationRelations, memberRelations, organization, organizationRelations, session (+15 more)

### Community 47 - "Campaign Runner Tests"
Cohesion: 0.12
Nodes (15): arguments(), decode_client_state(), describe(), encode_client_state(), place_campaign_call(), Namespace, Outbound campaign dialer (plan Day 7-8). Runs beside `server.py`, not inside…, Dial one lead. Returns True if Telnyx accepted the call. (+7 more)

### Community 48 - "Credential Encryption"
Cohesion: 0.17
Nodes (19): main(), option(), readSecretFromStdin(), updatePlatformCredential(), llmProviderAccounts, saveCredential(), base64ToBytes(), bytesToBase64() (+11 more)

### Community 49 - "Agent CRUD Actions"
Cohesion: 0.14
Nodes (19): AgentListRow, ChannelReadiness, createAgentAction(), DeleteResult, enqueueDeployment(), enqueueErrorCode(), GenerationPlaceholder, getAgent() (+11 more)

### Community 50 - "Wizard Step UI"
Cohesion: 0.16
Nodes (17): setCampaignStatusAction(), GenerationStatusCard(), flashClass(), GenerationStatusPhase, PersonalityStep(), PlanStep(), StepBodyProps, STYLE_SUGGESTIONS (+9 more)

### Community 51 - "Shadcn Components Config"
Cohesion: 0.09
Nodes (22): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+14 more)

### Community 52 - "Detail Pages"
Cohesion: 0.15
Nodes (14): listAgents(), listAgentsWithGeneration(), AgentsList(), CallDetail(), formatWhen(), listAgentOptions(), CampaignAgentOptions(), listPhoneNumbers() (+6 more)

### Community 53 - "Lead CSV Import"
Cohesion: 0.13
Nodes (18): RFC-4180, campaignLeads, FALSY_CONSENT, HEADER_ALIASES, LeadColumnMap, LeadCsvResult, normalizePhoneE164(), parseCsv() (+10 more)

### Community 54 - "Bridge Auth Secrets"
Cohesion: 0.22
Nodes (14): failure(), GET(), GET(), GET(), OperatorGate(), authorizeBridge(), BridgeAuth, bridgeError() (+6 more)

### Community 55 - "Edit Draft Cache"
Cohesion: 0.19
Nodes (13): coerceDeploymentState(), DeploymentState, EditAgent(), editDraftKey(), EditDraftSnapshot, parseEditDraftCache(), readEditDraft(), STATUS_VARIANT (+5 more)

### Community 56 - "Root Layout Toast"
Cohesion: 0.10
Nodes (12): geistMono, geistSans, metadata, ThemeProvider(), ToastAction(), ToastClose(), ToastContent(), ToastDescription() (+4 more)

### Community 57 - "Command Menu UI"
Cohesion: 0.14
Nodes (18): CommandItemDefinition, CommandMenu03(), CREATE_COMMANDS, DRILL_DOWN_COMMANDS, isCommandMenuEditableTarget(), Command(), CommandDialog(), CommandEmpty() (+10 more)

### Community 58 - "Proposal Executors"
Cohesion: 0.13
Nodes (17): EffectMetadata, Executor, ExecutorContext, stableStringify(), TargetSnapshot, AFFIRMATIONS, AssentVerdict, classifyAssent() (+9 more)

### Community 59 - "Job Schema Contracts"
Cohesion: 0.11
Nodes (19): agentDeploymentInputSchema, agentDeploymentResultSchema, agentGenerationInputSchema, agentGenerationResultSchema, integrationServiceSchema, integrationTestInputSchema, integrationTestResultSchema, IntegrationTestService (+11 more)

### Community 60 - "Telephony Tool Coordinator"
Cohesion: 0.25
Nodes (5): PendingTool, Any, AssemblyAI client-side tool sequencing for the Telnyx bridge. Tool work runs in…, Update sequencing state. True means a session.error was tool-local., ToolCoordinator

### Community 61 - "E2E Runner Script"
Cohesion: 0.27
Nodes (18): appDir, bootEnv(), buildCandidate(), capture(), fingerprint(), here, modeBehavior(), modeCloudflare() (+10 more)

### Community 62 - "Integration Health Probes"
Cohesion: 0.18
Nodes (16): integrationChecks, expectJson(), Fetch, IntegrationService, isLlmService(), LLM_ENDPOINTS, probeIntegration(), runLlmProbe() (+8 more)

### Community 63 - "Campaign Form UI"
Cohesion: 0.19
Nodes (15): createCampaignAction(), CampaignForm(), clampInt(), TIMEZONES, hashContent(), ImportSummary, LeadImport(), Preflight (+7 more)

### Community 64 - "Worker Queue Consumer"
Cohesion: 0.20
Nodes (10): POST(), POST(), NumberResult, db, agents, campaigns, phoneNumbers, consumeMessage() (+2 more)

### Community 65 - "Lead Detail Page"
Cohesion: 0.21
Nodes (10): LeadDetail(), MEMBERSHIP_LABEL, RecentCalls(), formatCallStatus(), callDuration(), relativeCallTime(), dialOutcomeLabel(), dispatchIdleLabel() (+2 more)

### Community 66 - "Onboarding Pipeline UI"
Cohesion: 0.17
Nodes (12): Onboarding06(), Onboarding06Props, TimelineEntry, TimelineState, meterValue(), Onboarding07(), Onboarding07Props, PipelineState (+4 more)

### Community 67 - "Bridge Config Client"
Cohesion: 0.23
Nodes (5): BridgeConfig, BridgeConfigClient, Short-lived Voni bridge configuration fetched before each call., BridgeConfigTests, FakeClient

### Community 68 - "App Manifest Generator"
Cohesion: 0.16
Nodes (15): APP_FEATURE_TERMS, AUTH_ROUTES, build(), EXAMPLES, generated, OUT, PHRASES, PLATFORM_ADMIN_ROUTES (+7 more)

### Community 69 - "Avatar Mascot UI"
Cohesion: 0.17
Nodes (13): GuideMascot(), MascotAvatar(), MascotMood, MOOD_META, GridList02(), initials(), people, Avatar() (+5 more)

### Community 70 - "Agent Provisioning API"
Cohesion: 0.27
Nodes (11): AgentDeploymentResult, comparableAgent(), deleteRemoteAgent(), deploymentFingerprint(), provisionAgent(), reconcileRecentAgent(), RemoteDeleteResult, requestAgent() (+3 more)

### Community 71 - "Table Dropdown UI"
Cohesion: 0.21
Nodes (11): Ai01Props, columns, data, Item, Status, statusConfig, DropdownMenu(), DropdownMenuContent() (+3 more)

### Community 72 - "Jobs Watch List"
Cohesion: 0.19
Nodes (11): JobFailureLines(), OptimisticPhase, StartOptions, WatchedResult, BACKGROUND_AFTER_MS, isTerminalStatus(), jobErrorCopy(), MinimalJob (+3 more)

### Community 73 - "Provider Tool Catalog"
Cohesion: 0.20
Nodes (13): providerConnections, CatalogHit, matchCatalogTool(), PROVIDER_CATALOG, ProviderId, ProviderMeta, squash(), ToolMeta (+5 more)

### Community 74 - "Tool Coordinator Tests"
Cohesion: 0.25
Nodes (4): FakeWebSocket, ToolCoordinator, StubCoordinator, ToolCoordinatorTests

### Community 75 - "Voice Preview API"
Cohesion: 0.27
Nodes (11): hitsByUser, POST(), buildPreviewText(), MAX_PREVIEW_CHARS, PREVIEW_CACHE_SECONDS, PREVIEW_RATE_LIMIT, PREVIEW_RATE_WINDOW_SECONDS, previewLocale() (+3 more)

### Community 76 - "App Guide Navigation"
Cohesion: 0.25
Nodes (11): NAV_ITEMS, SECTION_TITLES, escapeRegExp(), matchNavIntent(), renderAppGuide(), APP_DESTINATIONS, APP_FEATURE_TERMS, APP_MANIFEST_VERSION (+3 more)

### Community 77 - "Voice QA Script"
Cohesion: 0.24
Nodes (12): analyzePcm(), arg(), Artifact, decodeChannel(), fetchChecked(), main(), percentile(), sanitizeTranscript() (+4 more)

### Community 78 - "Delete Race Verifier"
Cohesion: 0.27
Nodes (12): agentRowById(), allAgentIds, allJobIds, cleanupScope(), dbHost, insertDeploymentJob(), insertScratchAgent(), sleep() (+4 more)

### Community 79 - "Rate Limit Tokens"
Cohesion: 0.26
Nodes (10): GET(), POST(), rateLimits, bumpRateBucket(), checkDemoLimits(), clientIp(), DEFAULTS, envInt() (+2 more)

### Community 80 - "Leads List Rows"
Cohesion: 0.19
Nodes (12): bulkStageSchema, LeadsBulkResult, listLeads(), ListLeadsOptions, ListLeadsResult, listLeadsRows(), RESERVED_STAGE_ALIASES, leadsChips() (+4 more)

### Community 81 - "Job Row UI"
Cohesion: 0.26
Nodes (10): computeStatusLabel(), JobActionButtons(), JobRow(), JobRowProps, JobRowState, JobTableRow(), primaryActionLabel(), useJobRowState() (+2 more)

### Community 82 - "Jobs Toast Provider"
Cohesion: 0.26
Nodes (11): initialNotificationsOn(), isTerminal(), JobsContext, JobsContextValue, JobsProvider(), jobStatusLabel(), OptimisticEntry, readToastState() (+3 more)

### Community 83 - "Copilot Voice Prefs"
Cohesion: 0.23
Nodes (10): INPUT_LANGUAGE_CODES, VOICE_IDS, coerceCopilotVoicePrefs(), CopilotVoicePrefs, copilotVoicePrefsSchema, DEFAULT_COPILOT_LANGUAGE, DEFAULT_COPILOT_VOICE, DEFAULT_COPILOT_VOICE_PREFS (+2 more)

### Community 84 - "Tag Field Logic"
Cohesion: 0.31
Nodes (8): DIR, TagField(), applyTagAdd(), applyTagRemove(), applyTagUpdate(), isTagAdded(), TagApplyResult, TagRejection

### Community 85 - "Live Jobs Refresh"
Cohesion: 0.24
Nodes (9): isForwardTransition(), LiveAgentsRefresh(), TERMINAL, WATCHED_KINDS, JobsContent(), RecordResults(), RecordSearchDestination(), useJobs() (+1 more)

### Community 86 - "TS Tool Coordinator"
Cohesion: 0.22
Nodes (5): ToolResponse, parseArguments(), Pending, ToolCall, ToolCoordinatorOptions

### Community 88 - "Brand SVG Kit"
Cohesion: 0.22
Nodes (9): Voni brand identity (resting-arc mark system), Voni chip app-icon dark (ink square, paper arc), Voni chip app-icon light (paper square, ink arc), Voni mark solo dark (paper resting arc), Voni mark solo light (ink resting arc), Voni wordmark mono black (arc V plus oni), Voni wordmark mono white (arc V plus oni), Voni wordmark dark (paper arc plus oni) (+1 more)

### Community 89 - "Agent Status Entries"
Cohesion: 0.33
Nodes (6): AgentStatusInput, buildAgentStatusEntries(), deploymentCopy(), formatTime(), base, JobJson

### Community 90 - "Streaming Concepts"
Cohesion: 0.29
Nodes (7): Speaker Diarization, Context Carryover, Streaming Diarization, Streaming PII Redaction, Streaming Turn Detection, UpdateConfiguration Dynamic Config, Voice Focus Noise Suppression

### Community 91 - "Campaign Dispatch Client"
Cohesion: 0.43
Nodes (3): ClientSession, DispatchClient, Voni's dispatch API — the queue, the policy, and the outcome log.

### Community 92 - "Avatar OG Images"
Cohesion: 0.29
Nodes (7): Avatar 1024px — white rounded square with black arch mark (light avatar), Avatar 400px — white rounded square with black arch mark (light avatar small variant), Avatar 500px — white rounded square with black arch mark (light avatar medium variant), Voni Brand Identity — arch mark, monochrome avatars and chips, OG cover, OG Cover 1200x630 — black social card with white Voni arch logo, voni wordmark and tagline It sees the lead. It seals the deal., Voni Chip Dark 1024px — black rounded square with white arch mark (dark inverse variant), Voni Chip Dark 512px — black rounded square with white arch mark (dark inverse small variant)

### Community 93 - "Brand PNG Kit"
Cohesion: 0.29
Nodes (7): Voni brand identity — shared arc-mark visual identity across press-kit PNGs, Voni chip light 1024 — rounded-square light icon with centered black arc mark, Voni chip light 512 — rounded-square light icon with centered black arc mark (small size), Voni mark dark 1024 — white arc glyph for dark backgrounds, Voni mark light 1024 — black arc glyph for light backgrounds, Voni wordmark dark 2048 — white 'voni' logotype with arc-v for dark backgrounds, Voni wordmark light 2048 — black 'voni' logotype with arc-v for light backgrounds

### Community 94 - "Calls Index Test"
Cohesion: 0.29
Nodes (6): agentsSource, dataSource, dir, formatSource, indexSource, sectionSource

### Community 95 - "Retry Card Test"
Cohesion: 0.29
Nodes (6): cardSource, dir, editSource, newSource, NOTE: voni has no @testing-library/react / jsdom (see package.json), and, startSource

### Community 96 - "Toggle Group UI"
Cohesion: 0.43
Nodes (5): ToggleGroup(), ToggleGroupContext, ToggleGroupItem(), Toggle(), toggleVariants

### Community 97 - "LLM Gateway Concepts"
Cohesion: 0.33
Nodes (6): Best-Effort Rewrite Fallback, Transcript Rewriting llm_instruction, Chat Completions Endpoint, Fallback Models, Transcribe Then Analyze Pattern, Understanding Endpoint

### Community 98 - "Dictation Sync SDKs"
Cohesion: 0.33
Nodes (6): JS DictationTranscriber client dictation, JS SyncTranscriber client sync, Python DictationTranscriber, Python SyncTranscriber, Dictation API, Sync STT API

### Community 99 - "Boilerplate Icon Set"
Cohesion: 0.33
Nodes (6): File Icon, Globe Icon, Next.js Logo, Next.js Default Template Icon Set, Vercel Logo, Window Icon

### Community 100 - "Press Raster Script"
Cohesion: 0.33
Nodes (5): here, Job, JOBS, OUT, PRESS

### Community 101 - "Leads Filters Test"
Cohesion: 0.33
Nodes (5): actionsSource, bulkSource, chipsSource, dir, pageSource

### Community 102 - "Wizard Timeline Test"
Cohesion: 0.33
Nodes (5): buttonSource, dir, NOTE: voni has no @testing-library/react / jsdom (see package.json), and, timelineBarSource, timelineSource

### Community 103 - "Campaign Queue Test"
Cohesion: 0.33
Nodes (5): componentsDir, controlsSource, pageDir, pageSource, queueSource

### Community 104 - "Tabs UI"
Cohesion: 0.40
Nodes (5): Tabs(), TabsContent(), TabsList(), tabsListVariants, TabsTrigger()

### Community 105 - "Mic Ownership Lock"
Cohesion: 0.60
Nodes (4): acquireMic(), currentMicOwner(), releaseMic(), resetMicOwnerForTests()

### Community 106 - "Cloudflare Worker Entry"
Cohesion: 0.33
Nodes (3): QueueBatch, worker, WorkerEnv

### Community 107 - "Async STT API"
Cohesion: 0.40
Nodes (5): File Upload Endpoint, PII Policies List, Poll Transcription Result, Submit Transcription Endpoint, Async Transcription Webhooks

### Community 108 - "Manual Call Placer"
Cohesion: 0.40
Nodes (3): arguments(), Namespace, Place one explicitly confirmed outbound call using Voni bridge defaults.

### Community 109 - "Session Audio Puller"
Cohesion: 0.70
Nodes (4): check_audio(), get(), main(), Look for dropouts inside the agent's own generated speech. Note the limit: this…

### Community 110 - "Wordmark Shots Script"
Cohesion: 0.40
Nodes (3): here, OUT, PRESS

### Community 111 - "Delete Button Test"
Cohesion: 0.40
Nodes (4): buttonSource, dir, editSource, pageSource

### Community 112 - "Page Gate Test"
Cohesion: 0.40
Nodes (4): dir, gateSource, pageSource, NOTE: voni has no @testing-library/react / jsdom (see package.json), and

### Community 113 - "Queue Bulk Actions"
Cohesion: 0.50
Nodes (5): orgCampaign(), queueBulkAction(), queueUndoRemoveAction(), CampaignQueue(), formatWhen()

### Community 114 - "Onboarding Statusline UI"
Cohesion: 0.40
Nodes (4): Onboarding05(), Onboarding05Props, StatuslineEntry, StatuslineState

### Community 115 - "Marker UI"
Cohesion: 0.50
Nodes (4): Marker(), MarkerContent(), MarkerIcon(), markerVariants

### Community 116 - "Unsaved Pill Test"
Cohesion: 0.40
Nodes (4): dir, editSource, pillSource, NOTE: voni has no @testing-library/react / jsdom (see package.json), and

### Community 117 - "LLM Gateway Auth"
Cohesion: 0.50
Nodes (4): Temporary Token Authentication, AssemblyAI API Key Authentication, LeMUR Deprecated API, LLM Gateway

### Community 118 - "Voice Agent Lifecycle"
Cohesion: 0.50
Nodes (4): Barge-In Interruption Handling, Voice Agent Session Lifecycle, Telephony Integration Twilio Telnyx, Voice Agent Tool Call Pattern

### Community 119 - "Universal Models"
Cohesion: 0.50
Nodes (4): Medical Mode Add-On, Universal-3.5 Pro Prompting, Universal-2 Model, Universal-3.5 Pro Model

### Community 120 - "Dev Loop Skill"
Cohesion: 0.67
Nodes (4): Agent Browser Verification, Next.js MCP Endpoint, Dev Loop Preflight Check, Edit Verify Loop

### Community 121 - "Graphify Plugin Config"
Cohesion: 0.50
Nodes (3): plugin, $schema, .opencode/plugins/graphify.js

### Community 122 - "Root Package Config"
Cohesion: 0.50
Nodes (3): devDependencies, typescript, typescript

### Community 123 - "Instant Nav Rig"
Cohesion: 0.50
Nodes (4): Task 5 E2E DB Creds Blocked Gate, Instant Navigation Production Test Rig, exposeTestingApiInProductionBuild Flag, Instant Trust Protocol

### Community 124 - "Package Metadata"
Cohesion: 0.50
Nodes (3): name, private, version

### Community 126 - "Property Seed Script"
Cohesion: 0.50
Nodes (3): availability, listings, sql

### Community 127 - "Calls Pagination Test"
Cohesion: 0.50
Nodes (3): dataSource, dir, pageSource

### Community 128 - "Lead State Cell Test"
Cohesion: 0.50
Nodes (3): cellSource, dir, pageSource

### Community 129 - "Wizard Reset Test"
Cohesion: 0.50
Nodes (3): dir, helperSource, newSource

### Community 130 - "Onboarding 07 Test"
Cohesion: 0.50
Nodes (3): dir, NOTE: voni has no @testing-library/react / jsdom (see package.json), and, source

### Community 131 - "Phone Labels Test"
Cohesion: 0.50
Nodes (3): dir, headerSource, source

### Community 132 - "Audio Intel Features"
Cohesion: 0.67
Nodes (3): Entity Detection, PII Redaction, Sentiment Analysis

### Community 133 - "JS SDK Clients"
Cohesion: 0.67
Nodes (3): AssemblyAI JS Client, JS LLM Gateway Client, JS Streaming Transcriber

### Community 134 - "Python SDK Clients"
Cohesion: 0.67
Nodes (3): Python Asyncio Support, Python RealTimeTranscriber, Python Transcriber

### Community 135 - "Speech Understanding Ops"
Cohesion: 0.67
Nodes (3): Custom Formatting, Speaker Identification, Speech Understanding Translation

### Community 137 - "App Icon Set"
Cohesion: 0.67
Nodes (3): Apple Touch Icon - White V on Black Rounded Square, Favicon SVG - Ink V Stroke on Paper Square, Voni App Icon Set

## Ambiguous Edges - Review These
- `BentoTile Settings Gallery` → `Voni Stack Notes`  [AMBIGUOUS]
  HANDOFF.md · relation: conceptually_related_to
- `Voni Design System` → `Next.js Starter README (Uncustomized)`  [AMBIGUOUS]
  voni/README.md · relation: conceptually_related_to

## Knowledge Gaps
- **688 isolated node(s):** `$schema`, `.opencode/plugins/graphify.js`, `$schema`, `type`, `npx` (+683 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **42 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `BentoTile Settings Gallery` and `Voni Stack Notes`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Voni Design System` and `Next.js Starter README (Uncustomized)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `cn()` connect `Shared UI Components` to `Leads Task Board`, `App Shell Auth`, `Agent Wizard Draft`, `Sidebar Navigation Shell`, `Settings Gallery Tiles`, `Agent Config Form`, `Dashboard Copilot Shell`, `Form UI Primitives`, `Voice Persona Catalog`, `Leads Bulk Selection`, `Chat Bubble UI`, `Carousel Voice Picker`, `Sheet Sidebar Primitives`, `Phone Number Binding`, `Wizard Step UI`, `Edit Draft Cache`, `Root Layout Toast`, `Command Menu UI`, `Campaign Form UI`, `Lead Detail Page`, `Onboarding Pipeline UI`, `Avatar Mascot UI`, `Table Dropdown UI`, `Tag Field Logic`, `Toggle Group UI`, `Tabs UI`, `Onboarding Statusline UI`, `Marker UI`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **Why does `db` connect `Worker Queue Consumer` to `Campaign Dialer Engine`, `App Shell Auth`, `Calls History List`, `Durable Jobs Core`, `Jobs API Routes`, `Business Tools Runtime`, `Voice Persona Catalog`, `Record Search Jobs`, `Settings Server Actions`, `Job Start API`, `Operator Credentials UI`, `Credential Encryption`, `Agent CRUD Actions`, `Detail Pages`, `Lead CSV Import`, `Bridge Auth Secrets`, `Integration Health Probes`, `Lead Detail Page`, `Provider Tool Catalog`, `Rate Limit Tokens`, `Leads List Rows`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `Button()` connect `Edit Draft Cache` to `Shared UI Components`, `Leads Task Board`, `App Shell Auth`, `Agent Wizard Draft`, `Calls History List`, `Agent Config Form`, `Route Error Screens`, `Dashboard Copilot Shell`, `Form UI Primitives`, `Voice Persona Catalog`, `Leads Bulk Selection`, `Chat Bubble UI`, `Carousel Voice Picker`, `Sheet Sidebar Primitives`, `Phone Number Binding`, `Wizard Step UI`, `Detail Pages`, `Root Layout Toast`, `Command Menu UI`, `Campaign Form UI`, `Lead Detail Page`, `Table Dropdown UI`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **What connects `$schema`, `.opencode/plugins/graphify.js`, `$schema` to the rest of the system?**
  _688 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Copilot Element Catalog` be split into smaller, more focused modules?**
  _Cohesion score 0.07758031442241968 - nodes in this community are weakly interconnected._