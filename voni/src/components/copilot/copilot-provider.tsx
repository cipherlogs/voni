/**
 * Global voice copilot provider. Mounted once in the dashboard layout so one
 * voice session survives in-app navigation.
 *
 * The provider owns the AssemblyAI session, the proposal store, and the
 * command copilotBus. Pages contribute route-scoped tools through `registerRoute`
 * (tools + target readers + screen brief); navigation swaps the session's
 * tool array and expires the departed route's proposals. Expensive truth:
 * the model operates numbered screen controls (ui_tap/ui_fill) and every
 * data change runs through bus-confirmed proposals — view-state taps apply
 * at once, nothing else does.
 *
 * Liveness rule: every bus call reads the CURRENT route/registration from
 * refs. The session outlives navigation, so closures captured at start() are
 * stale by the second screen — never use them for authorization context.
 */

"use client";

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { z } from "zod";
import {
  RateLimitError,
  VoiceSession,
  type TranscriptPartial,
  type VoiceError,
  type VoiceState,
} from "@/lib/voice/session";
import { CopilotBus, globalToolDefs, type BusContext, type BusToolResult, type RegisteredTool } from "@/lib/copilot/bus";
import { ProposalStore, type Proposal } from "@/lib/copilot/proposals";
import {
  buildKeyterms,
  buildSystemPrompt,
  buildTranscriptionPrompt,
  COPILOT_GREETING,
} from "@/lib/copilot/prompt";
import {
  buildScheduleProposal,
  executeCancelJob,
  executeRetryJob,
  executeScheduleJob,
  jobIdArgs,
  proposeScheduleArgs,
  readJobStatus,
} from "@/lib/copilot/jobs-tools";
import { shouldCheckIn, shouldEndIdle } from "@/lib/copilot/idle";
import {
  coerceCopilotVoicePrefs,
  DEFAULT_COPILOT_VOICE_PREFS,
  prefsLanguageCodes,
  type CopilotVoicePrefs,
} from "@/lib/copilot/voice-prefs";
import { classifyPartialNav, renderAppGuide } from "@/lib/copilot/app-guide";
import {
  getSessionPrefetchRoutes,
  prefetchCandidates,
} from "@/lib/copilot/voice-prefetch";
import { requestVoiceJudge } from "@/lib/voice/jev-judges";
import { NAVIGABLE_ROUTES } from "@/lib/copilot/app-manifest";
import { useJobs } from "@/components/jobs/jobs-provider";
import { toast } from "@/components/ui/toast";
import { recordTools } from "@/lib/copilot/record-tools";
import { ScreenTools } from "@/lib/copilot/ui-tools";
import { getCopilotVoicePrefs } from "@/app/(dashboard)/settings/actions";

export const IDLE_MS = 60_000;
const CHECK_IN_LEAD_MS = 10_000;

export type CopilotStatus =
  | "idle"
  | "starting"
  | "live"
  | "reconnecting"
  | "error";

export type CaptionTurn = {
  id: string;
  role: "user" | "agent";
  text: string;
};

export type RouteToolConfig = {
  tools: RegisteredTool[];
  targets: Map<string, () => { value: unknown; version: number | string } | null>;
  brief: string;
};

export type ProposeChangeInput = {
  target: { kind: string; id: string };
  payload: unknown;
  executor: string;
  summary: string;
  keyPhrases: string[];
  inverse?: { summary: string; payload: unknown } | null;
};

type CopilotContextValue = {
  status: CopilotStatus;
  error: VoiceError | null;
  /** True while the user muted their own mic — the call stays up, frames drop. */
  micMuted: boolean;
  /** True while the copilot's voice output is silenced (volume 0). */
  speakerMuted: boolean;
  live: boolean;
  captions: CaptionTurn[];
  userPartial: string | null;
  agentPartial: string | null;
  proposals: Proposal[];
  toolActive: boolean;
  sessionSeconds: number | null;
  /** AssemblyAI session id for support (docs: persist it, don't guess). */
  sessionId: string | null;
  start: () => void;
  stop: () => void;
  toggleMicMute: () => void;
  toggleSpeakerMute: () => void;
  applyTap: (id: string) => void;
  dismissTap: (id: string) => void;
  noteInteraction: () => void;
  registerRoute: (route: string, config: RouteToolConfig) => void;
  unregisterRoute: (route: string) => void;
  /** Tool-run helper: create a proposal from a registered propose tool. */
  proposeChange: (
    input: ProposeChangeInput,
    ctx: BusContext,
  ) => { proposal_id: string; summary: string };
  /** Tool-run helper: propose undoing the most recent applied change here. */
  proposeUndo: (ctx: BusContext) => {
    ok: boolean;
    proposal_id?: string;
    summary?: string;
    error?: string;
  };
};

const CopilotContext = createContext<CopilotContextValue | null>(null);

export function useCopilot(): CopilotContextValue {
  const value = useContext(CopilotContext);
  if (!value) throw new Error("useCopilot must be used inside CopilotProvider.");
  return value;
}

async function copilotToken(): Promise<{ token: string; maxSessionSeconds?: number }> {
  const res = await fetch("/api/copilot/token");
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      throw new RateLimitError(
        error ?? "Voice copilot is starting too often.",
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
      );
    }
    throw new Error(error ?? "Could not start the voice copilot.");
  }
  return res.json();
}

let captionSeq = 0;
const nextCaptionId = () => `cap-${(captionSeq += 1)}`;

/**
 * Destinations voice may open: registered result pages only. Anything else
 * (external URLs, unknown paths) is refused — the model never invents
 * navigation targets.
 */
const OPENABLE_DESTINATION = /^\/(agents\/new\?job=[\w-]+|agents\/[0-9a-f-]+|settings(\/(account|voice|workspace|services|appearance))?|operator|jobs|dashboard|campaigns\/[0-9a-f-]+)(\?.*)?$/;

export function CopilotProvider({
  children,
  enabled,
  platformAdmin = false,
}: {
  children: React.ReactNode;
  /** While false: no token requests, no microphone, no tool execution, no
   *  prefs fetch. The shell sets this from auth readiness (myplan.md Task 8).
   *  The provider instance stays mounted across signed-in navigation. */
  enabled: boolean;
  platformAdmin?: boolean;
}) {
  const { addOptimistic, removeOptimistic, refresh } = useJobs();
  const router = useRouter();
  const sessionRef = useRef<VoiceSession | null>(null);
  const [core] = useState(() => {
    const store = new ProposalStore();
    return { store, bus: new CopilotBus(store) };
  });
  const { store: proposalStore, bus: copilotBus } = core;
  const routeConfigs = useRef(new Map<string, RouteToolConfig>());
  const registrationRef = useRef(0);
  // Route tracking lives in CopilotRouteSync below (behind Suspense): the
  // provider itself must not call usePathname at the top, or every dynamic
  // route fails prerender validation. Defaults to "/" until the sync lands.
  const routeRef = useRef("/");
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const screenTools = useRef<ScreenTools | null>(null);
  const navigationRef = useRef<{ destination: string; promise: Promise<BusToolResult> } | null>(null);
  const idleRef = useRef({ lastActivityAt: 0, checkInSent: false, suspended: false });
  const micMutedRef = useRef(false);
  const speakerMutedRef = useRef(false);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReadbacks = useRef(new Map<string, string>());
  const lastBargeRef = useRef(0);
  /** Mid-sentence speculation: debounce timer, warmed routes, last push. */
  const speculativeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchSeenRef = useRef(new Set<string>());
  const lastSpeculativeNavRef = useRef<string | null>(null);
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const platformAdminRef = useRef(platformAdmin);
  useEffect(() => {
    platformAdminRef.current = platformAdmin;
  }, [platformAdmin]);
  /**
   * Last known voice prefs, refreshed on mount, navigation, and save.
   * start() reads this synchronously so the mic never waits on a fetch;
   * the voice is immutable once the session opens, so saves apply to the
   * next conversation, not the live one.
   */
  const prefsRef = useRef<CopilotVoicePrefs>({ ...DEFAULT_COPILOT_VOICE_PREFS });

  const [status, setStatus] = useState<CopilotStatus>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [captions, setCaptions] = useState<CaptionTurn[]>([]);
  const [userPartial, setUserPartial] = useState<string | null>(null);
  const [agentPartial, setAgentPartial] = useState<string | null>(null);
  const [toolActive, setToolActive] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const proposalVersion = useSyncExternalStore(
    useCallback((fn: () => void) => proposalStore.subscribe(fn), [proposalStore]),
    useCallback(() => proposalStore.getVersion(), [proposalStore]),
    // Server snapshot: proposals only exist client-side; start at zero.
    useCallback(() => 0, []),
  );

  const noteActivity = useCallback(() => {
    idleRef.current.lastActivityAt = Date.now();
    idleRef.current.checkInSent = false;
  }, []);

  const noteInteraction = useCallback(() => {
    noteActivity();
  }, [noteActivity]);

  /** Always current — the session outlives navigation, closures don't. */
  const liveContext = useCallback((): BusContext => {
    const route = routeRef.current;
    return {
      userId: "copilot-user",
      organizationId: "copilot-org",
      sessionId: "copilot-session",
      route,
      registration: registrationRef.current,
      targets: new Map([
        ...(routeConfigs.current.get(route)?.targets ?? []),
        ...(screenTools.current?.targets ?? []),
      ]),
    };
  }, []);

  const sessionToolsFor = useCallback(
    (route: string) => {
      return [
        ...globalToolDefs(),
        ...copilotBus.visibleTools(route).map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execution_mode: tool.mode,
          timeout_seconds: 15,
        })),
      ];
    },
    [copilotBus],
  );

  const pushScreenContext = useCallback(
    (route: string) => {
      const session = sessionRef.current;
      if (!session) return;
      const brief =
        routeConfigs.current.get(route)?.brief ?? "(no screen details available)";
      void session
        .updateConfig(
          {
            system_prompt: buildSystemPrompt({ route, screenBrief: brief, appGuide: renderAppGuide(platformAdmin) }),
            input: {
              transcription_prompt: buildTranscriptionPrompt(route),
              keyterms: buildKeyterms(route),
            },
            tools: sessionToolsFor(route),
          },
          { coalescible: true },
        )
        .catch(() => {
          /* Uncertainty surfaces via onConfigUncertainty; tools stay gated. */
        });
    },
    [sessionToolsFor, platformAdmin],
  );

  const clearTimers = useCallback(() => {
    if (capTimerRef.current) clearTimeout(capTimerRef.current);
    if (wrapTimerRef.current) clearTimeout(wrapTimerRef.current);
    capTimerRef.current = null;
    wrapTimerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    clearTimers();
    if (speculativeTimerRef.current) clearTimeout(speculativeTimerRef.current);
    speculativeTimerRef.current = null;
    lastSpeculativeNavRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    micMutedRef.current = false;
    speakerMutedRef.current = false;
    setMicMuted(false);
    setSpeakerMuted(false);
    setSessionId(null);
    // Unapplied proposals die with the session — nothing confirmed applies later.
    proposalStore.expireWhere(
      (p) => p.status === "pending" || p.status === "armed",
    );
    pendingReadbacks.current.clear();
    if (session) {
      void session.stop().catch(() => undefined);
    }
    setToolActive(false);
    setUserPartial(null);
    setAgentPartial(null);
    setStatus("idle");
  }, [clearTimers, proposalStore]);

  // Leaving readiness stops any live session and invalidates pending
  // proposals before another identity could act on them. stop() also clears
  // transcripts and captions, so no previous user's state remains visible.
  // Deferred a tick: calling it synchronously in the effect trips the
  // set-state-in-effect rule and cascading renders.
  useEffect(() => {
    if (!enabled) {
      const timer = setTimeout(() => stop(), 0);
      return () => clearTimeout(timer);
    }
  }, [enabled, stop]);

  const start = useCallback(() => {
    // Gated on auth readiness: no token request, no microphone, no tools
    // while the session is still loading. The rail button explains the
    // state and stays navigable.
    if (!enabledRef.current) return;
    if (sessionRef.current) return;
    // Mutual exclusion with the agent-test VoiceCall: whoever starts ends
    // the other first. No parked, billable sessions on either side.
    window.dispatchEvent(
      new CustomEvent("voni:voice-preempt", { detail: { owner: "copilot" } }),
    );
    setError(null);
    setCaptions([]);
    setSessionSeconds(null);
    setSessionId(null);
    setStatus("starting");
    noteActivity();

    let sessionCapSeconds = 900;

    const session = new VoiceSession(
      {
        onStateChange: (state: VoiceState) => {
          if (state === "listening" || state === "speaking") setStatus("live");
          else if (state === "reconnecting") setStatus("reconnecting");
          else if (state === "connecting") setStatus("starting");
          else if (state === "ended") {
            if (sessionRef.current) stop();
          }
        },
        onUserPartial: (partial: TranscriptPartial) => {
          setUserPartial(partial.text || null);
          lastBargeRef.current = Date.now();
          noteActivity();
          // Mid-sentence speculation: heuristic executes now (<1ms), Jev
          // validates async. Final `ui_navigate` stays authoritative and
          // corrects any misfire. Skipped while a proposal awaits confirm
          // so the page never yanks mid-readback.
          const text = partial.text || "";
          if (speculativeTimerRef.current) clearTimeout(speculativeTimerRef.current);
          speculativeTimerRef.current = setTimeout(() => {
            if (pendingReadbacks.current.size > 0) return;
            const current = routeRef.current;
            const decision = classifyPartialNav(text, current, platformAdminRef.current);
            const liveRouter = routerRef.current;
            if (decision.action === "navigate") {
              if (lastSpeculativeNavRef.current === decision.route) return;
              lastSpeculativeNavRef.current = decision.route;
              try {
                liveRouter.push(decision.route);
              } catch {
                /* Reversible speculation — the confirmed turn retries. */
              }
              void prefetchCandidates(
                (r) => liveRouter.prefetch(r),
                [decision.route],
                prefetchSeenRef.current,
              );
              // Jev validates in the background; result is telemetry only —
              // never blocks the push, final turn corrects misfires.
              void requestVoiceJudge(
                "nav-speculative",
                {
                  partialText: text.slice(-200),
                  candidateRoute: decision.route,
                  confidence: decision.confidence,
                },
                { timeoutMs: 120 },
              ).catch(() => undefined);
            } else if (decision.action === "prefetch") {
              void prefetchCandidates(
                (r) => liveRouter.prefetch(r),
                decision.candidates,
                prefetchSeenRef.current,
              );
            }
          }, 80);
        },
        onAgentPartial: (partial: TranscriptPartial) => {
          setAgentPartial(partial.text || null);
        },
        onUserTurn: (turn) => {
          setUserPartial(null);
          setCaptions((prev) =>
            [...prev, { id: nextCaptionId(), role: "user" as const, text: turn.text }].slice(-30),
          );
          noteActivity();
          const heard = copilotBus.recordVoiceTurn(
            turn.itemId ?? nextCaptionId(),
            turn.text,
            liveContext(),
          );
          if (heard.needsDisambiguation) {
            session.requestReply(
              "Two changes are pending — tell me which one to apply, by name.",
            );
          }
        },
        onAgentTurn: (turn) => {
          setAgentPartial(null);
          setCaptions((prev) =>
            [...prev, { id: nextCaptionId(), role: "agent" as const, text: turn.text }].slice(-30),
          );
          noteActivity();
          const candidates = copilotBus.recordAgentTurn(turn.itemId ?? nextCaptionId(), turn.text);
          for (const id of candidates) {
            pendingReadbacks.current.set(id, turn.itemId ?? "");
          }
        },
        onReplyDone: (info) => {
          noteActivity();
          if (info.interrupted) {
            // Interrupted readback never arms — Apply stays disabled.
            pendingReadbacks.current.clear();
            return;
          }
          // Arm only once the reply actually finished sounding. Playback may
          // still be draining, so retry briefly rather than arming deaf.
          let attempts = 0;
          const tryArm = () => {
            const current = sessionRef.current;
            if (!current || current !== session) return;
            if (Date.now() < lastBargeRef.current) return;
            if (!current.playbackSettled() && attempts < 6) {
              attempts += 1;
              setTimeout(tryArm, 500);
              return;
            }
            if (!current.playbackSettled()) return;
            for (const id of pendingReadbacks.current.keys()) {
              proposalStore.arm(id);
            }
            pendingReadbacks.current.clear();
          };
          setTimeout(tryArm, 400);
        },
        onToolActivity: (active) => {
          setToolActive(active);
          if (active) noteActivity();
        },
        onConfigUncertainty: () => {
        },
        onSessionEnded: (info) => {
          if (typeof info.audioSeconds === "number") {
            setSessionSeconds(info.audioSeconds);
          }
        },
        onSessionReady: (id) => setSessionId(id),
        onAudioProbe: (event) => {
          // Owner device runs read these to pin each pop to its cut.
          console.debug("[voice-audio]", event);
        },
        onError: (err) => {
          setError(err);
          setStatus("error");
        },
      },
      {
        micOwner: "copilot",
        toolExecutor: async (call) => {
          const live = sessionRef.current;
          if (live && !live.isConfigSynced() && call.name !== "proposals_read") {
            return {
              ok: false,
              error: "My controls are resyncing — one moment, then try again.",
              retryable: true,
            };
          }
          idleRef.current.suspended = true;
          try {
            const result = await copilotBus.dispatch(
              call.name,
              call.arguments,
              liveContext(),
            );
            return result.ok
              ? { ok: true as const, data: result.data }
              : { ok: false as const, error: result.error, retryable: result.retryable };
          } finally {
            idleRef.current.suspended = false;
            noteActivity();
          }
        },
      },
    );
    sessionRef.current = session;

    const route = routeRef.current;
    // Prefs snapshot for this conversation: the voice is immutable once the
    // session opens, so mid-call saves wait for the next start.
    const prefs = prefsRef.current;
    const fetcher = async () => {
      const tok = await copilotToken();
      if (typeof tok.maxSessionSeconds === "number") {
        sessionCapSeconds = tok.maxSessionSeconds;
      }
      return tok;
    };
    void session
      .start(
        {
          mode: "inline",
          systemPrompt: buildSystemPrompt({
            route,
            screenBrief:
              routeConfigs.current.get(route)?.brief ?? "(no screen details available)",
            appGuide: renderAppGuide(platformAdmin),
          }),
          greeting: COPILOT_GREETING,
          voiceId: prefs.voiceId,
          languageCodes: prefsLanguageCodes(prefs) ?? undefined,
          // First-utterance tuning: VAD windows, STT mode, scene, and
          // vocabulary ship in the opening update, not after it.
          transcriptionPrompt: buildTranscriptionPrompt(route),
          keyterms: buildKeyterms(route),
          transcriptionMode: "min_latency",
          turnDetection: {
            min_silence: 500,
            max_silence: 2000,
            interrupt_response: true,
            interruption_delay: 0,
          },
          tools: sessionToolsFor(route),
        },
        fetcher,
      )
      .then(() => {
        // The server gives no closing warning, so run our own timers: wrap
        // up gracefully before the cap, then stop on it.
        clearTimers();
        // Fresh speculation state per conversation; warm every static
        // destination in the background so a mid-sentence push paints
        // instantly instead of flashing a loading skeleton.
        prefetchSeenRef.current = new Set();
        lastSpeculativeNavRef.current = null;
        void prefetchCandidates(
          (r) => routerRef.current.prefetch(r),
          getSessionPrefetchRoutes(platformAdminRef.current),
          prefetchSeenRef.current,
        );
        const wrapAt = Math.max(0, (sessionCapSeconds - 30) * 1000);
        wrapTimerRef.current = setTimeout(() => {
          sessionRef.current?.requestReply("We're nearly at time — one last thing?");
        }, wrapAt);
        capTimerRef.current = setTimeout(() => stop(), sessionCapSeconds * 1000);
      })
      .catch(() => {
        // start() reports through onError; nothing to add here.
      });
  }, [noteActivity, sessionToolsFor, stop, liveContext, proposalStore, copilotBus, clearTimers, platformAdmin]);

  // Idle rule while live: soft check-in, then end. Typing and taps extend
  // the clock through noteActivity/noteInteraction.
  useEffect(() => {
    if (status !== "live" && status !== "reconnecting") return;
    const tick = setInterval(() => {
      const ref = idleRef.current;
      const now = Date.now();
      if (
        shouldCheckIn({
          now,
          lastActivityAt: ref.lastActivityAt,
          idleMs: IDLE_MS,
          checkInLeadMs: CHECK_IN_LEAD_MS,
          live: true,
          suspended: ref.suspended,
          checkInSent: ref.checkInSent,
        })
      ) {
        ref.checkInSent = true;
        sessionRef.current?.requestReply("Still with me?");
      }
      if (
        shouldEndIdle({
          now,
          lastActivityAt: ref.lastActivityAt,
          idleMs: IDLE_MS,
          live: true,
          suspended: ref.suspended,
        })
      ) {
        stop();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [status, stop]);

  // Navigation: new registration, expire the departed scope, republish.
  // Driven by CopilotRouteSync (behind Suspense) so the provider itself
  // never reads URL data at the top level.
  const handleRouteChange = useCallback(
    (route: string) => {
      screenTools.current?.invalidate();
      registrationRef.current += 1;
      const registration = registrationRef.current;
      routeRef.current = route;
      proposalStore.expireWhere(
        (p) => p.route !== route || p.registration !== registration,
      );
      sessionRef.current?.invalidatePendingUpdates();
      if (sessionRef.current) pushScreenContext(route);
    },
    [proposalStore, pushScreenContext],
  );

  // Voice prefs: load on mount, refresh on save. Failures keep defaults —
  // prefs must never block the mic. Skipped entirely until auth is ready:
  // no authenticated requests while the session is loading.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => {
      getCopilotVoicePrefs()
        .then((stored) => {
          if (alive) prefsRef.current = coerceCopilotVoicePrefs(stored);
        })
        .catch(() => undefined);
    };
    load();
    const onSaved = () => load();
    window.addEventListener("voni:voice-prefs-changed", onSaved);
    return () => {
      alive = false;
      window.removeEventListener("voni:voice-prefs-changed", onSaved);
    };
  }, [enabled]);

  // Mutual exclusion: the agent-test call preempts us, we preempt it.
  useEffect(() => {
    const onPreempt = (event: Event) => {
      const owner = (event as CustomEvent<{ owner?: string }>).detail?.owner;
      if (owner && owner !== "copilot" && sessionRef.current) stop();
    };
    window.addEventListener("voni:voice-preempt", onPreempt);
    return () => window.removeEventListener("voni:voice-preempt", onPreempt);
  }, [stop]);

  const proposeChange = useCallback(
    (input: ProposeChangeInput, ctx: BusContext) => {
      const reader = ctx.targets.get(`${input.target.kind}:${input.target.id}`);
      const current = reader?.() ?? null;
      const proposal = proposalStore.create({
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        sessionId: ctx.sessionId,
        route: ctx.route,
        registration: ctx.registration,
        target: input.target,
        expected: current
          ? { value: current.value, version: current.version }
          : { value: null, version: 0 },
        payload: input.payload,
        executor: input.executor,
        summary: input.summary,
        keyPhrases: input.keyPhrases,
        inverse: input.inverse ?? null,
      });
      return { proposal_id: proposal.id, summary: proposal.summary };
    },
    [proposalStore],
  );

  const proposeUndo = useCallback(
    (ctx: BusContext) => {
      const applied = proposalStore
        .list("applied")
        .filter((p) => p.route === ctx.route && p.registration === ctx.registration)
        .at(-1);
      if (!applied) {
        return { ok: false as const, error: "Nothing applied here yet — nothing to undo." };
      }
      const built = copilotBus.buildUndoProposal(applied.id, ctx);
      if (!built.ok) return { ok: false as const, error: built.error };
      const proposal = proposalStore.create(built.input);
      return { ok: true as const, proposal_id: proposal.id, summary: proposal.summary };
    },
    [proposalStore, copilotBus],
  );


  const navigateVerified = useCallback((destination: string): Promise<BusToolResult> => {
    const pending = navigationRef.current;
    if (pending) return pending.destination === destination ? pending.promise : Promise.resolve({ ok: false, error: "A navigation is still settling. Read the screen before opening another destination.", retryable: true });
    const targetPath = destination.split("?")[0];
    const promise = (async (): Promise<BusToolResult> => {
      const targetUrl = new URL(destination, window.location.origin);
      const locationMatches = () => window.location.pathname === targetUrl.pathname && window.location.search === targetUrl.search;
      if (!locationMatches()) router.push(destination);
      for (let i = 0; i < 40; i++) {
        if (locationMatches() && routeRef.current === targetPath && routeConfigs.current.has(targetPath)) return { ok: true, data: { accepted: true, completed: true, navigated: destination, registration: registrationRef.current } };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { ok: true, data: { accepted: true, completed: false, destination, next: "Navigation is pending. Call ui_read_screen to verify the destination; do not claim it opened yet." } };
    })();
    navigationRef.current = { destination, promise };
    void promise.finally(() => { if (navigationRef.current?.promise === promise) navigationRef.current = null; });
    return promise;
  }, [router]);

  // Global read-only tools, registered once. Route tools arrive per page.
  useEffect(() => {
    // Navigable routes come from the GENERATED app manifest — adding a screen
    // to the rail teaches voice the destination with no prompt edit.
    const allowedRoutes = platformAdmin
      ? NAVIGABLE_ROUTES
      : NAVIGABLE_ROUTES.filter((route) => route !== "/operator");
    const routeEnum = allowedRoutes as [string, ...string[]];
    copilotBus.register({
      name: "ui_navigate",
      description:
        "Go to another screen. Call when the user asks to open or go to a named section.",
      parameters: {
        type: "object",
        properties: { route: { type: "string", enum: [...routeEnum] } },
        required: ["route"],
        additionalProperties: false,
      },
      schema: z.object({ route: z.enum(routeEnum) }),
      effect: { mutates: false, scope: "navigation", reversible: true },
      routes: "*",
      mode: "interactive",
      listed: true,
      run: async (args) => {
        const { route } = args as { route: string };
        return navigateVerified(route);
      },
      executor: null,
    });
    const controls = new ScreenTools({
      root: () => document,
      context: liveContext,
      brief: () => routeConfigs.current.get(routeRef.current)?.brief ?? "No screen details available.",
      propose: proposeChange,
      navigate: navigateVerified,
    });
    screenTools.current = controls;
    for (const tool of controls.tools()) copilotBus.register(tool);
    for (const tool of recordTools({ navigate: navigateVerified, route: () => routeRef.current, addOptimistic, removeOptimistic, refresh, background: (message) => toast.add({ title: message }) })) copilotBus.register(tool);
    const readOnly = {
      effect: { mutates: false, scope: "jobs", reversible: true },
      routes: "*" as const,
      mode: "interactive" as const,
      listed: true,
    };
    copilotBus.register({
      name: "jobs_propose_schedule",
      description:
        "Propose starting a background job: generating an agent draft (needs a brief of at least a sentence) or testing a platform connection (needs the service name). Returns a proposal id and summary — read the summary back verbatim, then wait for yes or Apply before calling confirm_proposal.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["agent_generation", "integration_test"] },
          brief: { type: "string" },
          service: { type: "string" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      schema: proposeScheduleArgs,
      ...readOnly,
      run: async (args, ctx) => {
        const parsed = proposeScheduleArgs.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            error: "Say what to start: a generation needs a brief, a connection test needs the service.",
            retryable: false,
          };
        }
        const built = buildScheduleProposal(parsed.data);
        const { proposal_id } = proposeChange(
          {
            target: { kind: "job-schedule", id: parsed.data.kind },
            payload: {
              kind: parsed.data.kind,
              title: built.title,
              input: built.input,
              idempotencyKey: `voice-${crypto.randomUUID()}`,
            },
            executor: "jobs_schedule_exec",
            summary: built.summary,
            keyPhrases: built.keyPhrases,
            inverse: null,
          },
          ctx,
        );
        return {
          ok: true,
          data: {
            proposal_id,
            summary: built.summary,
            next: "Read the summary back verbatim, then await yes or Apply.",
          },
        };
      },
      executor: null,
    });
    copilotBus.register({
      name: "jobs_schedule_exec",
      description: "Internal: schedules a confirmed job. Never call directly — propose first.",
      parameters: { type: "object" },
      // Loose on purpose: the executor validates the frozen payload strictly.
      schema: z.object({}).catchall(z.unknown()),
      effect: { mutates: true, scope: "jobs", reversible: false },
      routes: "*",
      mode: "interactive",
      listed: false,
      run: null,
      executor: executeScheduleJob,
    });
    const retryCancelPairs: ReadonlyArray<readonly [string, string, "retry" | "cancel", string]> = [
      ["jobs_retry_propose", "jobs_retry_exec", "retry", "Retry"],
      ["jobs_cancel_propose", "jobs_cancel_exec", "cancel", "Cancel"],
    ];
    for (const [proposeName, execName, action, verb] of retryCancelPairs) {
      copilotBus.register({
        name: proposeName,
        description: `Propose to ${action} a background job by id. Returns a proposal id and summary — read it back, then await confirmation.`,
        parameters: {
          type: "object",
          properties: { job_id: { type: "string" } },
          required: ["job_id"],
          additionalProperties: false,
        },
        schema: jobIdArgs,
        ...readOnly,
        run: async (args, ctx) => {
          const parsed = jobIdArgs.safeParse(args);
          if (!parsed.success) {
            return { ok: false, error: "Say which job by its id.", retryable: false };
          }
          let job: { title: string; status: string; updatedAt: string | null };
          try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(parsed.data.job_id)}`, {
              cache: "no-store",
            });
            if (res.status === 404) {
              return { ok: false, error: "No job with that id.", retryable: false };
            }
            if (!res.ok) throw new Error("read failed");
            ({ job } = (await res.json()) as { job: typeof job });
          } catch {
            return { ok: false, error: "Could not read that job right now.", retryable: true };
          }
          const summary = `${verb} "${job.title}" (currently ${job.status})`;
          const { proposal_id } = proposeChange(
            {
              target: { kind: "job", id: parsed.data.job_id },
              payload: { job_id: parsed.data.job_id },
              executor: execName,
              summary,
              keyPhrases: [verb.toLowerCase(), job.title],
              inverse: null,
            },
            ctx,
          );
          return {
            ok: true,
            data: {
              proposal_id,
              summary,
              next: "Read the summary back verbatim, then await yes or Apply.",
            },
          };
        },
        executor: null,
      });
      copilotBus.register({
        name: execName,
        description: `Internal: ${action}s a confirmed job. Never call directly — propose first.`,
        parameters: { type: "object" },
        schema: jobIdArgs,
        effect: { mutates: true, scope: "jobs", reversible: false },
        routes: "*",
        mode: "interactive",
        listed: false,
        run: null,
        executor: action === "retry" ? executeRetryJob : executeCancelJob,
      });
    }
    copilotBus.register({
      name: "jobs_read_status",
      description:
        "Read a background job's status, title, result destination, error and completed result, including record matches and continuation. Call when the user asks what a job is doing or whether it finished.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
      schema: jobIdArgs,
      ...readOnly,
      run: async (args) => {
        const parsed = jobIdArgs.safeParse(args);
        if (!parsed.success) {
          return { ok: false, error: "Say which job by its id.", retryable: false };
        }
        try {
          return { ok: true, data: { ...(await readJobStatus(parsed.data.job_id)) } };
        } catch {
          return { ok: false, error: "Could not read that job right now.", retryable: true };
        }
      },
      executor: null,
    });
    copilotBus.register({
      name: "ui_open_result",
      description:
        "Open a job's result destination. Call with the job id when the user asks to see or open a finished job.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
      schema: jobIdArgs,
      ...readOnly,
      run: async (args) => {
        const parsed = jobIdArgs.safeParse(args);
        if (!parsed.success) {
          return { ok: false, error: "Say which job by its id.", retryable: false };
        }
        try {
          const status = await readJobStatus(parsed.data.job_id);
          const destination = status.target_url;
          if (!destination || !OPENABLE_DESTINATION.test(destination)) {
            return { ok: false, error: "That job has no openable destination.", retryable: false };
          }
          return navigateVerified(destination);
        } catch {
          return { ok: false, error: "Could not open that job right now.", retryable: true };
        }
      },
      executor: null,
    });
  }, [router, copilotBus, proposeChange, liveContext, navigateVerified, addOptimistic, removeOptimistic, refresh, platformAdmin]);

  // Never strand a billable session on unmount or sign-out.
  useEffect(() => {
    return () => {
      clearTimers();
      void sessionRef.current?.stop().catch(() => undefined);
      sessionRef.current = null;
    };
  }, [clearTimers]);

  const toggleMicMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    setMicMuted(next);
    session.setInputMuted(next);
    noteActivity();
  }, [noteActivity]);

  const toggleSpeakerMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const next = !speakerMutedRef.current;
    speakerMutedRef.current = next;
    setSpeakerMuted(next);
    noteActivity();
    void session
      .updateConfig({ output: { volume: next ? 0 : 100 } })
      .catch(() => undefined);
  }, [noteActivity]);

  const applyTap = useCallback(
    (id: string) => {
      noteActivity();
      proposalStore.attachTapAssent(id);
    },
    [noteActivity, proposalStore],
  );

  const dismissTap = useCallback(
    (id: string) => {
      noteActivity();
      copilotBus.dismissProposal(id);
    },
    [noteActivity, copilotBus],
  );

  const registerRoute = useCallback(
    (route: string, config: RouteToolConfig) => {
      routeConfigs.current.set(route, config);
      for (const tool of config.tools) copilotBus.register(tool);
      if (sessionRef.current && routeRef.current === route) {
        pushScreenContext(route);
      }
    },
    [pushScreenContext, copilotBus],
  );

  const unregisterRoute = useCallback((route: string) => {
    routeConfigs.current.delete(route);
  }, []);

  const proposals = useMemo(() => {
    // Subscribed version: rebuild the visible slice on every store mutation.
    void proposalVersion;
    return proposalStore
      .list()
      .filter((p) => p.status === "pending" || p.status === "armed");
  }, [proposalStore, proposalVersion]);

  const value = useMemo<CopilotContextValue>(
    () => ({
      status,
      error,
      micMuted,
      speakerMuted,
      live: status === "live" || status === "reconnecting",
      captions,
      userPartial,
      agentPartial,
      proposals,
      toolActive,
      sessionSeconds,
      sessionId,
      start,
      stop,
      toggleMicMute,
      toggleSpeakerMute,
      applyTap,
      dismissTap,
      noteInteraction,
      registerRoute,
      unregisterRoute,
      proposeChange,
      proposeUndo,
    }),
    [
      status,
      error,
      micMuted,
      speakerMuted,
      captions,
      userPartial,
      agentPartial,
      proposals,
      toolActive,
      sessionSeconds,
      sessionId,
      start,
      stop,
      toggleMicMute,
      toggleSpeakerMute,
      applyTap,
      dismissTap,
      noteInteraction,
      registerRoute,
      unregisterRoute,
      proposeChange,
      proposeUndo,
    ],
  );

  return (
    <CopilotContext.Provider value={value}>
      {/* Route sync behind Suspense: owns the usePathname call so dynamic
          routes keep a prerenderable shell. */}
      <Suspense fallback={null}>
        <CopilotRouteSync onRoute={handleRouteChange} />
      </Suspense>
      {children}
    </CopilotContext.Provider>
  );
}

/**
 * Self-reading route leaf for CopilotProvider. Forwards the current route
 * (and only the route) upward; renders nothing.
 */
function CopilotRouteSync({ onRoute }: { onRoute: (route: string) => void }) {
  const pathname = usePathname();
  const route = pathname ?? "/";
  useEffect(() => {
    onRoute(route);
  }, [route, onRoute]);
  return null;
}

/**
 * Page hook: publish this route's tools, target readers, and screen brief.
 * Tools merge into the session on register and on every navigation.
 */
export function useCopilotRoute(route: string, config: RouteToolConfig) {
  const { registerRoute, unregisterRoute } = useCopilot();
  useEffect(() => {
    // Pages should memoize `config` (e.g. keyed by a brief string) so this
    // only re-registers when something actually changed.
    registerRoute(route, config);
    return () => unregisterRoute(route);
  }, [route, config, registerRoute, unregisterRoute]);
}
