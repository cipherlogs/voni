# Voice copilot coverage

This is implementation and browser/tool evidence for the supplied coverage plan. Live spoken/device verification has not been performed. No simulated transcript in this report is labeled live voice. The developer server is Next 16.3.4 on port 3000; browser verification used agent-browser 0.36.0 and the production provider/bus through React introspection. Test records were isolated draft fixtures. No calls were placed and no platform credentials were changed.

## Outcome and scope

Manifest v2 scans all 16 page routes, including four dynamic templates and three public/auth pages. Only the nine generated static signed-in destinations are accepted by `ui_navigate`. Record discovery returns creator-scoped opaque references; `ui_open_record` checks membership, job ownership and record existence again.

Controls are harvested from rendered DOM into immutable snapshots. Returned refs include the snapshot namespace. Element identity includes a component/record key when supplied and a session-local element instance; ordinal labels are only spoken disambiguators. Reordered controls keep their identity, while replacements, edits, changed destinations/effects, disabled state, modal changes and departed registrations fail closed. No old number is looked up in a new list.

The full catalog stays in memory. Reads return pages of 60 with total, scopes, query and continuation. A continuation requires the same snapshot/scope/query. Controls outside the viewport remain discoverable. Hidden/inert/CSS-hidden ancestors are excluded. Shared Dialog and Sheet wrappers publish modal state, including Base UI sheets that omit `aria-modal`; owned portaled options remain in that scope.

Names resolve `aria-labelledby`, `aria-label`, native/associated/wrapping labels, then appropriate control text/placeholder/title. Decorative SVG text and credential values are excluded. Private form fields contribute only a change version to internal confirmation checks. Uploads expose file metadata, never local paths. The confirmation card's Apply control cannot be synthetically tapped to manufacture assent.

`accepted` means the action was dispatched or a job was durably queued. `completed` requires observed route registration/location, tab, dialog, selection or field state. Unknown completion remains unverified. Reading never retries or reapplies a mutation. Partial speech no longer initiates navigation.

## Route and state audit

Counts below are from the initial browser pass with fixture data and include shared controls. Later mobile checks naturally have fewer controls because the sidebar is closed. A count is evidence of that rendered state, not a hardcoded product count. All listed controls are harvested after the source fixes; absent product functionality is stated explicitly.

| Screen/state | Controls | Harvested? | Voice phrase | Validation evidence |
| --- | --- | --- | --- | --- |
| `/` | Public/auth page | outside tool-enabled access | Not offered by signed-in navigation | Manifest access `public`, navigation kind `none`; no copilot provider. |
| `/agents` | Agent cards, new-agent link, details links, empty state | yes | Show my agents | Browser read: 13 controls; route registered. Static navigation tool verified destination. |
| `/agents/[id]` | Name/identity, mission, greeting, native voice/language selections, knowledge/intents/blockers, detect fields, tools/channels, save, deployment status and test-call controls | yes | Find an agent named Sara | Browser read: 69 controls; route registered. Overflow retained, 60 + remainder. |
| `/agents/new` | Goal templates and text; personality/name fields; task editing; Review; Back/Continue; preview sheet; existing wizard tools | yes | Create a new agent | Browser read: 21 controls; route registered. Static navigation tool verified destination. |
| `/calls/[id]` | Authorized call identity, direction, dates and transcript count; shared controls. Transcript playback and reasoning trace are not implemented. | yes | Find calls for Alex | Browser read: 10 controls; route registered. Opened via authorized record search; cold navigation returned pending until the destination registered. |
| `/campaigns` | New campaign, campaign cards and status; empty state | yes | Open campaigns | Browser read: 12 controls; route registered. Static navigation tool verified destination. |
| `/campaigns/[id]` | Back, activation/pause controls and disabled blocker, upload, selected-file import, queue links, empty queue and dialer state | yes | Find a campaign named Viewings | Browser read: 14 controls; route registered. Opened via authorized record search; cold navigation returned pending until the destination registered. |
| `/campaigns/new` | Name, agent/consent/timezone selections, start/end time, weekdays, attempts/retry timing, create and validation/empty-agent state | yes | Create a campaign | Browser read: 27 controls; route registered. Static navigation tool verified destination. |
| `/dashboard` | Shared navigation, job status, copilot; recent activity and empty states | yes | Open dashboard | Browser read: 10 controls; route registered. Static navigation tool verified destination. |
| `/jobs` | Active/Needs review/All tabs, search, per-job open/retry/cancel/dismiss, finished dismissal, search result destination and continuation, empty states | yes | Open background jobs | Browser read: 14 controls; route registered. Static navigation tool verified destination. |
| `/leads` | Lead links, status/consent columns and empty state | yes | Open leads | Browser read: 33 controls; route registered. Static navigation tool verified destination. |
| `/leads/[id]` | Authorized lead name/phone, pipeline/consent, latest intent/blockers/next action; shared controls. Timeline is not implemented. | yes | Find a lead named Alex | Browser read: 10 controls; route registered. Opened via authorized record search; cold navigation returned pending until the destination registered. |
| `/login` | Public/auth page | outside tool-enabled access | Not offered by signed-in navigation | Manifest access `auth`, navigation kind `none`; no copilot provider. |
| `/numbers` | Number/label, Answered by, Add, per-number agent selection/removal, empty/default-agent state | yes | Show phone numbers | Browser read: 14 controls; route registered. Static navigation tool verified destination. |
| `/settings` | Account/sign-out; Voice and Language plus Save; workspace fields/disabled permission; service readiness; appearance; admin-only Platform | yes | Open settings | Browser read: 16 controls; route registered. Static navigation tool verified destination. |
| `/signup` | Public/auth page | outside tool-enabled access | Not offered by signed-in navigation | Manifest access `auth`, navigation kind `none`; no copilot provider. |

## Overlay and control coverage

| Screen/state | Controls | Harvested? | Voice phrase | Expected and observed |
| --- | --- | --- | --- | --- |
| Settings / each visible tab | Account, Voice copilot, Workspace, Services, Appearance | yes | Open the Voice copilot tab | Tool selected the tab and returned `completed: true`. Brief now names the current and available tabs. |
| Settings / Platform without admin access | Absent tab | no, intentionally absent | Open Platform settings | Tool refused the unavailable tab. Admin-only controls are source-audited; no admin browser session was used. |
| Settings / Voice and Language popups | Base UI options, selected state, Save | yes; names fixed at source where needed | Select Ivy | Popup and options read in browser. Proposal refused before readback; simulated readback plus separate assent applied the selection and verified it. Save was not invoked on the owner's preferences. |
| Settings / workspace fields and readiness | Associated labels, disabled fields, service status | yes | Read workspace settings | Browser read and tab checks. Credential values remain manual/private. |
| Wizard / Goal, Personality, Tasks, Review | Timeline, fields, task controls, Back/Continue, disabled Back | yes | Go to Review | Browser tool traversed steps; existing wizard tools and rendered step/task brief remain registered together. |
| Wizard / mobile Preview sheet | Preview jump controls and Close | yes | Show preview; close preview | Browser verified opening/closing and active dialog scope. Background header/jobs controls are excluded while modal is active. |
| Mobile sidebar and account menu | Navigation, account actions, Close | yes | Open the sidebar; open account menu | Browser opened portaled sidebar and menu and read their controls. |
| Agent details / dense form | Fields, native options, language choices, dynamic list controls | yes | Read more controls | Initial browser catalog had 69 controls. Unit pagination covers 137 controls without loss; visible-control comparison found zero unharvested controls in the tested form. |
| Campaign creation / selections and dates | Agent, timezone, consent, time inputs, weekdays | yes; ambiguous selection names fixed | Set start time to 09:00 | Browser read found no unharvested visible controls. Input/selection confirmation is covered by adapter and bus tests. |
| Campaign / CSV before selection | Visible shadcn file input; disabled import | yes | Show the CSV upload | Tool revealed the input and requested manual selection; it never selected a path or dispatched a file click. |
| Campaign / selected CSV | Filename/size/version, import button | yes | Import the selected CSV | Browser file selection sent zero import requests. Unconfirmed proposal was refused. Confirmed acceptance survives navigation/reload; invalid CSV failure and valid fixture import are recorded separately. |
| Jobs / search/filter/empty state | Search and tabs | yes, explicit view effects | Search jobs for failed | Search applies immediately; form inputs still propose. Search/continuation and state tests cover stale tokens and changed values. |
| Jobs / active, failed, cancelled, completed | Named row controls, versioned targets, error text | yes | Cancel that job; retry that job | Browser proposal/assent/confirm exercised cancel and retry; duplicate confirms replayed one result. Auth/rate-limit failures have distinct text. |
| Jobs / record results | Descriptive matches and More matches | yes | Open the second matching agent | All four record kinds searched and opened through authorized references. Lead search returned 20 matches then 2; repeated searches reused the job ID. Direct result URL worked after reload. |
| Shared job pill | Expand/collapse, scoped job rows, result links | yes | Expand jobs | Explicit view semantics; rendered job rows have record keys and names. |
| Shared copilot / live controls | Start/end, mic/speaker mute, panel, proposal Apply/Dismiss | yes when rendered | Mute my mic; end the call | Source and adapter coverage, with explicit view effects and pressed state. Actual live-call operation remains unverified. Apply requires independently observed assent. |
| Sorting and pagination controls | Native/role controls plus explicit view metadata | supported; no table sort UI currently exists | Sort by name; next page | Adapter supports explicit view effects. Do not invent a sort control on a screen without one. Record and catalog pagination are tested. |

## Three utterances per signed-in route

These are acceptance phrases, not claims that speech recognition or a live conversation was tested. The observed column describes the corresponding browser/tool behavior. Record names in execution used a unique test prefix to avoid touching unrelated records.

| Route | Utterance 1 | Utterance 2 | Utterance 3 | Expected | Observed |
| --- | --- | --- | --- | --- | --- |
| `/agents` | Show my agents | Find an agent named Sara | Open the agent library | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/agents/[id]` | Find an agent named Sara | Open the second matching agent | Read this agent configuration | Search the authorized record type, require selection when ambiguous, open only the returned reference, then read actual record state. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/agents/new` | Create a new agent | Read this wizard step | Go to review | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/calls/[id]` | Find calls for Alex | Open the first matching call | Read this call summary | Search the authorized record type, require selection when ambiguous, open only the returned reference, then read actual record state. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/campaigns` | Open campaigns | Find my viewing campaign | Show active campaigns | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/campaigns/[id]` | Find a campaign named Viewings | Read this campaign queue | Show the CSV upload control | Search the authorized record type, require selection when ambiguous, open only the returned reference, then read actual record state. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/campaigns/new` | Create a campaign | Read the campaign fields | Set campaign name to Viewings | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/dashboard` | Open dashboard | Show the overview | Read recent calls | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/jobs` | Open background jobs | Show failed jobs | Read job status | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/leads` | Open leads | Find a lead named Alex | Read the lead list | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/leads/[id]` | Find a lead named Alex | Open the second matching lead | Read this lead status | Search the authorized record type, require selection when ambiguous, open only the returned reference, then read actual record state. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/numbers` | Show phone numbers | Read the number assignments | Show available number actions | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |
| `/settings` | Open settings | Open the Voice copilot tab | Set voice to Ivy | Open the registered destination and read its rendered controls; any edit proposes before application. | Destination and control read verified through browser/tools. Live utterances not performed. |

## Async design answers

Record search may exceed three seconds and requires no continuous interaction. Its request becomes a `record_search` job before returning 202 with a job ID. The database and existing queue/processor retain its input, state and result. The global job pill/header and Jobs page provide status, retry, cancellation and completion notification. Results open at `/jobs?search=<jobId>`, including after reload. Fast completion returns matches to the waiting copilot. After three seconds, a still-waiting initiating page gets the required background message. That message is emitted only after durable acceptance.

Search and open endpoints resolve the current server session and workspace. Search jobs and opaque references are creator-scoped. Workers recheck membership; opening rechecks existence and access. A continuation restores kind/query/cursor from the creator's stored result. Fabricated references and raw record IDs cannot open a record. A failed open invalidates its cached search request so repeating the search can obtain fresh matches.

CSV selection is foreground manual input. Selection itself starts no job. The selected file's metadata and selection version participate in confirmation checks. Import then durably stages the file and starts the existing import job. Its stable submission key is retained for reconciliation and duplicate confirmation cannot execute twice. The existing job UI supplies failure/retry/cancellation and the campaign result destination.

In `next dev`, OpenNext creates an emulated queue producer without a running consumer. Development now dispatches the shared processor directly after durable storage; deployed workers continue using Cloudflare Queue. Production queue delivery was not exercised in this session.

## Validation and limits

- Unit tests cover stale snapshots, duplicate-row reorder/replacement, typed edits before confirmation, changed destination/effect/disabled state, hidden/CSS-hidden ancestors, noisy/associated labels, native options, portaled options, Base UI modal metadata, full overflow pagination, explicit view search, manual upload handoff, and synthetic Apply refusal. Existing independent-assent, readback, duplicate-confirm, interruption, navigation-expiry and uncertain-outcome tests remain enabled.
- Real database verifier `npm run test:copilot:integration` passed ambiguity, 20+2 pagination, duplicate creation/delivery, deleted/fabricated references, cross-user/workspace isolation, revoked membership, cancellation and retry. It creates isolated accounts/workspaces and cleans them in `finally`.
- Browser tests passed record search/open for all four types, duplicate job reconciliation, proposal-gated Base UI selection, settings visibility, wizard steps and preview sheet, mobile navigation, cancellation/retry/duplicate confirmation, result reload, and simulated fetch failure/reconnection. A deliberately queued search was processed while the browser was closed, then read from another page.
- CSV validation failure and successful fixture import were tested through manual browser file selection, proposal confirmation, navigation away and reload. No live calling/provider side effects were used.
- Next MCP compilation/errors and agent-browser DOM/React checks are recorded with the evidence artifact. Cold dynamic navigation sometimes exceeded the two-second observation window; tools correctly returned accepted/pending and the following read verified the registered destination.
- Admin-only Platform controls and genuine live voice, microphone permissions, audible readback/barge-in, and real network/device reconnection remain unverified. All simulated transcript events are browser tests.

The plan referred to a separate “supplied coverage rule” without including its text. Root AGENTS.md and CLAUDE.md use the available plan Summary verbatim as the coverage instruction. The missing separate wording was requested during implementation.
