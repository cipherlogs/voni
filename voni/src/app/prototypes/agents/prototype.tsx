"use client";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Plus, Phone, Layers, SlidersHorizontal, List, Check, Trash2, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel, FieldDescription, FieldGroup, FieldSet } from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { LoadingButton } from "@/components/loading-button";
import { cn } from "@/lib/utils";
import { advance, blank, initialModel, isActive, jobLabel, jobMessage, type Agent, type Direction, type Job, type Model, type Outcome } from "./model";
import "./prototype.css";
const directions = {
    guided: { title: "Guided workspace", summary: "A clear path from an idea to a ready agent.", description: "Browse your directory, create in focused steps, then review and test in a split workspace.", icon: List },
    studio: { title: "Agent studio", summary: "Your agents and their work, side by side.", description: "Keep your agent navigator in view. Create, configure, and test within one workspace.", icon: Layers },
    progressive: { title: "Progressive editor", summary: "See the whole agent. Focus on one decision.", description: "Start with a compact list, open a section to edit, and expand testing when you need it.", icon: SlidersHorizontal },
};
const subscribe = () => () => { };
const hashSubscribe = (cb: () => void) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); };
const getHash = () => window.location.hash.slice(1).split("/")[0];
export default function AgentFlowPrototypes() {
    const mounted = useSyncExternalStore(subscribe, () => true, () => false);
    const hash = useSyncExternalStore(hashSubscribe, getHash, () => "");
    const direction = hash in directions ? hash as Direction : null;
    return <div className="agent-prototype">{mounted && direction ? <Workspace key={direction} direction={direction}/> : <Comparison />}</div>;
}
function Comparison() {
    return <main className="comparison">
    <div className="brand">voni <Badge variant="outline">Interactive prototypes</Badge></div>
    <header className="comparison-heading"><h1>Three ways to build<br />your next agent.</h1><p>One visual identity. Three complete workflows. Explore each with the same agents and choose the way you want to work.</p></header>
    <div className="comparison-grid">{Object.entries(directions).map(([key, d]) => <Card key={key}>
      <CardHeader><CardTitle><h2>{d.title}</h2></CardTitle><CardDescription>{d.summary}</CardDescription></CardHeader>
      <CardContent><div className={cn("preview-layout", key)} aria-hidden="true"><div className="preview-nav"><i /><i /><i /></div><div className="preview-body"><i /><i /><i /></div><div className="preview-rail"><Phone /><i /></div></div><p>{d.description}</p></CardContent>
      <CardFooter><Button nativeButton={false} render={<a href={`#${key}`}/>}>Explore {d.title.toLowerCase()}<ArrowRight data-icon="inline-end"/></Button></CardFooter>
    </Card>)}</div>
    <Alert><FlaskConical /><AlertTitle>A safe place to compare</AlertTitle><AlertDescription>All agents, calls, deployments, and background jobs are simulated. Each direction saves its own sample data in this browser. No real calls or product changes occur.</AlertDescription></Alert>
    <section className="comparison-notes"><h2>Try the same task in each</h2><p>Create a property advisor, review its draft, change its greeting, test it, and deploy. Then try a failed deployment and delete Leo. Vera demonstrates deletion blocked by a campaign.</p><p>Use <strong>Scenarios</strong> for first use and failure outcomes, <strong>Jobs</strong> to leave work running, and <strong>Components</strong> for the reusable control specimen.</p></section>
  </main>;
}
function Panel({ title, description, children, footer }: {
    title: string;
    description?: string;
    children: ReactNode;
    footer?: ReactNode;
}) {
    return <Card><CardHeader><CardTitle><h2>{title}</h2></CardTitle>{description && <CardDescription>{description}</CardDescription>}</CardHeader><CardContent>{children}</CardContent>{footer && <CardFooter>{footer}</CardFooter>}</Card>;
}
function TextField({ label, value, onChange, multiline, error, hint }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    multiline?: boolean;
    error?: string;
    hint?: string;
}) {
    const id = label.toLowerCase().replaceAll(/[^a-z]+/g, "-");
    return <Field data-invalid={Boolean(error)}><FieldLabel htmlFor={id}>{label}</FieldLabel>{multiline ? <Textarea id={id} value={value} aria-invalid={Boolean(error)} aria-describedby={error || hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)} rows={4}/> : <InputGroup><InputGroupInput id={id} value={value} aria-invalid={Boolean(error)} aria-describedby={error || hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)}/></InputGroup>}{(error || hint) && <FieldDescription id={`${id}-hint`}>{error || hint}</FieldDescription>}</Field>;
}
function Choices({ label, options, value, onChange, multiple = false }: {
    label: string;
    options: string[];
    value: string[];
    onChange: (v: string[]) => void;
    multiple?: boolean;
}) {
    return <Field><FieldLabel>{label}</FieldLabel><ToggleGroup aria-label={label} multiple={multiple} value={value} onValueChange={(v) => { if (v.length)
        onChange(v); }} variant="outline" className="flex-wrap">{options.map((o) => <ToggleGroupItem key={o} value={o}>{o}</ToggleGroupItem>)}</ToggleGroup></Field>;
}
type Screen = "list" | "create" | "edit" | "jobs" | "components" | "browse";
function Workspace({ direction }: {
    direction: Direction;
}) {
    const storageKey = `voni-agent-flow-prototype-v1-${direction}`;
    const [model, setModel] = useState<Model>(() => { try {
        const raw = localStorage.getItem(storageKey);
        return advance(raw ? JSON.parse(raw) : initialModel(), Date.now());
    }
    catch {
        return initialModel();
    } });
    const modelRef = useRef(model);
    const [screen, setScreen] = useState<Screen>("list");
    const [editing, setEditing] = useState<Agent>({ ...blank });
    const [baseline, setBaseline] = useState("");
    const [step, setStep] = useState(0);
    const [section, setSection] = useState<string | null>(null);
    const [showTest, setShowTest] = useState(false);
    const [errors, setErrors] = useState(false);
    const [notice, setNotice] = useState("");
    const [scenario, setScenario] = useState(false);
    const [outcome, setOutcome] = useState<Outcome>("success");
    const [dialog, setDialog] = useState<"leave" | "discard" | "delete" | "reset" | null>(null);
    const [typedName, setTypedName] = useState("");
    const pendingNavigation = useRef<() => void>(() => { });
    const initiator = useRef<HTMLElement | null>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    const [storageError, setStorageError] = useState(false);
    const acceptedSave = model.jobs.some((j) => isActive(j) && j.kind === "save" && JSON.stringify(j.agent) === JSON.stringify(editing));
    const dirty = (screen === "edit" || screen === "create") && JSON.stringify(editing) !== baseline && !acceptedSave;
    const persistedStatus = model.agents.find((a) => a.id === editing.id)?.status || "Draft";
    const active = model.jobs.filter(isActive);
    const currentJob = model.jobs.find((j) => j.agent.id === editing.id);
    const busy = active.some((j) => j.agent.id === editing.id);
    const persist = (next: Model) => { try {
        localStorage.setItem(storageKey, JSON.stringify(next));
        modelRef.current = next;
        setModel(next);
        return true;
    }
    catch {
        setStorageError(true);
        return false;
    } };
    useEffect(() => {
        const timer = window.setInterval(() => {
            const old = modelRef.current;
            const next = advance(old, Date.now());
            if (next !== old) {
                try {
                    localStorage.setItem(storageKey, JSON.stringify(next));
                    modelRef.current = next;
                    setModel(next);
                }
                catch {
                    setStorageError(true);
                }
            }
        }, 300);
        const sync = (event: StorageEvent) => { if (event.key === storageKey && event.newValue) {
            try {
                const next = JSON.parse(event.newValue);
                modelRef.current = next;
                setModel(next);
            }
            catch { /* Ignore malformed prototype storage. */ }
        } };
        window.addEventListener("storage", sync);
        return () => { clearInterval(timer); window.removeEventListener("storage", sync); };
    }, [storageKey]);
    useEffect(() => { heading.current?.focus(); }, [screen]);
    useEffect(() => {
        const warn = (event: BeforeUnloadEvent) => { if (dirty)
            event.preventDefault(); };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    useEffect(() => {
        if (!currentJob || currentJob.status !== "succeeded")
            return;
        // Completion only navigates when the initiating screen is still visible.
        const timer = setTimeout(() => {
            if (currentJob.kind === "generate" && screen === "create")
                openAgent(currentJob.agent.id);
            if (currentJob.kind === "save")
                setBaseline(JSON.stringify(currentJob.agent));
            if (currentJob.kind === "delete" && screen === "edit") {
                setScreen("list");
                setNotice(jobMessage(currentJob));
            }
        }, 0);
        return () => clearTimeout(timer);
        // openAgent intentionally reads the model containing this completed job.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentJob?.id, currentJob?.status]);
    function openDialog(value: typeof dialog) { initiator.current = document.activeElement as HTMLElement; setTypedName(""); setDialog(value); }
    function closeDialog() { setDialog(null); setTimeout(() => initiator.current?.focus(), 0); }
    function navigate(action: () => void) { if (dirty) {
        pendingNavigation.current = action;
        openDialog("leave");
    }
    else
        action(); }
    function go(next: Screen) { navigate(() => setScreen(next)); }
    function openAgent(id: string) { const agent = modelRef.current.agents.find((a) => a.id === id); if (!agent)
        return; setEditing(structuredClone(agent)); setBaseline(JSON.stringify(agent)); setScreen("edit"); setSection(null); setErrors(false); }
    function create() { navigate(() => { const next = { ...structuredClone(blank), id: `sample-${crypto.randomUUID()}` }; setEditing(next); setBaseline(JSON.stringify(next)); setStep(0); setScreen("create"); setErrors(false); }); }
    function update<K extends keyof Agent>(key: K, value: Agent[K]) { setEditing((a) => ({ ...a, [key]: value })); }
    function valid() {
        setErrors(true);
        const field = !editing.name.trim() ? "agent-name" : editing.mission.trim().length < 15 ? "mission" : !editing.greeting.trim() ? "first-message" : null;
        if (field) {
            setSection(field === "agent-name" ? "Identity" : "Mission");
            setTimeout(() => document.getElementById(field)?.focus(), 0);
        }
        return !field;
    }
    function enqueue(kind: Job["kind"], agent = editing) {
        if (modelRef.current.jobs.some((j) => isActive(j) && j.agent.id === agent.id))
            return;
        const job: Job = { id: crypto.randomUUID(), kind, agent: structuredClone(agent), started: Date.now(), duration: kind === "save" ? 900 : 8000, outcome, status: "queued" };
        if (persist({ ...modelRef.current, jobs: [job, ...modelRef.current.jobs] })) {
            if (kind === "generate")
                setBaseline(JSON.stringify(agent));
            setNotice(`${jobLabel(job)} accepted. You can follow it in Jobs.`);
            closeDialog();
        }
    }
    function cancel(job: Job) { persist({ ...modelRef.current, jobs: modelRef.current.jobs.map((j) => j.id === job.id ? { ...j, status: "cancelled" } : j) }); setNotice("Job cancelled. Your saved agent is unchanged."); }
    function reset(empty = false) { if (persist({ agents: empty ? [] : initialModel().agents, jobs: [] })) {
        setScreen("list");
        setNotice(empty ? "First-use scenario loaded." : "Sample agents restored.");
        closeDialog();
        setScenario(false);
    } }
    const title = screen === "list" ? "Agents" : screen === "create" ? "Create an agent" : screen === "edit" ? editing.name : screen === "jobs" ? "Background jobs" : screen === "browse" ? "Workspace overview" : "Component specimen";
    const configuration = (part: string) => <FieldGroup>
    {part === "Identity" && <><TextField label="Agent name" value={editing.name} onChange={(v) => update("name", v)} error={errors && !editing.name.trim() ? "Give your agent a name." : undefined}/><TextField label="Role" value={editing.role} onChange={(v) => update("role", v)}/><Choices label="Personality" options={["Warm", "Direct", "Professional"]} value={[editing.personality]} onChange={(v) => update("personality", v[0])}/></>}
    {part === "Mission" && <><TextField label="Mission" value={editing.mission} multiline onChange={(v) => update("mission", v)} hint="Describe the outcome, important questions, and when to hand off." error={errors && editing.mission.trim().length < 15 ? "Describe the mission in at least 15 characters." : undefined}/><TextField label="First message" value={editing.greeting} multiline onChange={(v) => update("greeting", v)} error={errors && !editing.greeting.trim() ? "Add a first message." : undefined}/></>}
    {part === "Conversation" && <><TextField label="House rules" value={editing.knowledge ?? blank.knowledge} multiline onChange={(v) => update("knowledge", v)}/><TextField label="Tasks" value={editing.tasks ?? blank.tasks} multiline onChange={(v) => update("tasks", v)}/><Field><FieldLabel>Detect and remember</FieldLabel><ToggleGroup aria-label="Detect and remember" multiple value={editing.detect ?? blank.detect} onValueChange={(v) => update("detect", v)} variant="outline" className="flex-wrap">{["Budget", "Location", "Timeline", "Property type", "Contact details"].map((v) => <ToggleGroupItem key={v} value={v}>{v}</ToggleGroupItem>)}</ToggleGroup><FieldDescription>Unchecked details can still be answered, but the agent will not ask for them.</FieldDescription></Field><Choices label="Voice" options={["Clara", "Leo", "Sofia"]} value={[editing.voice]} onChange={(v) => update("voice", v[0])}/><Choices label="Language" options={["English", "French", "Arabic"]} value={[editing.language]} onChange={(v) => update("language", v[0])}/><FieldDescription>Voice changes take effect in a fresh test session. Audio previews are simulated in this prototype.</FieldDescription><Button variant="outline" onClick={() => setNotice(`Simulated voice preview: ${editing.voice}, ${editing.language}. No audio is played.`)}>Preview voice</Button></>}
    {part === "Tools & channels" && <><Choices label="Channels (choose at least one)" multiple options={["Phone calls", "WhatsApp"]} value={editing.channels} onChange={(v) => update("channels", v)}/><Field><FieldLabel>Tools</FieldLabel><ToggleGroup multiple value={editing.tools} onValueChange={(v) => update("tools", v)} variant="outline" className="flex-wrap">{["Search properties", "Check availability", "Book viewing", "Update lead", "Transfer to human"].map((t) => <ToggleGroupItem value={t} key={t}>{t}</ToggleGroupItem>)}</ToggleGroup><FieldDescription>Bookings, lead updates, and transfers require a readback and confirmation. Test calls only simulate tool results.</FieldDescription></Field></>}
  </FieldGroup>;
    const sectionDescriptions: Record<string, string> = { Identity: "Who the agent is and how it comes across.", Mission: "The outcome it works toward, in your own words.", Conversation: "Voice, language, and the way a conversation begins.", "Tools & channels": "What it can do and where customers reach it." };
    const parts = Object.keys(sectionDescriptions);
    const listContent = <>
    <div className="list-intro"><div><p>{model.agents.length} agents · {model.agents.filter((a) => a.status === "Ready").length} ready</p><p>Give every conversation a clear purpose.</p></div><Button onClick={create}><Plus data-icon="inline-start"/>Create agent</Button></div>
    {model.agents.length === 0 ? <Empty><EmptyHeader><EmptyTitle>Your first agent starts here</EmptyTitle><EmptyDescription>Describe what you want to achieve. Voni will prepare a draft for you to review and test.</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={create}>Create your first agent</Button></EmptyContent></Empty> : <div className={cn("agent-directory", direction === "progressive" && "compact-directory")}>
      {model.agents.map((a) => <Card key={a.id}><CardHeader><div className="agent-row"><div className="agent-initial" aria-hidden="true">{a.name[0]}</div><div><CardTitle>{a.name}</CardTitle><CardDescription>{a.role}</CardDescription></div><Badge variant="outline">{a.status}</Badge></div></CardHeader><CardContent><p>{a.mission}</p><div className="row">{a.channels.map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}</div></CardContent><CardFooter><Button variant="outline" onClick={() => openAgent(a.id)}>{a.status === "Draft" ? `Review ${a.name}` : `Open ${a.name}`}<ArrowRight data-icon="inline-end"/></Button></CardFooter></Card>)}
    </div>}
  </>;
    const createContent = <div className={cn("creation", direction)}>
    {direction !== "studio" && <nav aria-label="Creation progress" className="steps">{["Purpose", "Personality & voice", "Review request"].map((s, i) => <span aria-current={step === i ? "step" : undefined} key={s}><b>{i + 1}</b>{s}</span>)}</nav>}
    <Panel title={direction === "studio" ? "Build in your studio" : ["What should your agent achieve?", "Make it sound like your team", "Ready to generate a draft?"][step]} description={direction === "studio" ? "Set a purpose and conversation style. Your generated draft opens in this workspace." : "Your agent remains a draft until you review, save, and deploy it."}>
      <FieldSet disabled={busy}>{direction === "studio" ? <div className="stack">{parts.slice(0, 3).map((p) => <section key={p}><h3>{p}</h3>{configuration(p)}</section>)}</div> : step === 0 ? <FieldGroup><TextField label="Agent name" value={editing.name} onChange={(v) => update("name", v)} error={errors && !editing.name.trim() ? "Give your agent a name." : undefined}/><TextField label="Mission" value={editing.mission} multiline onChange={(v) => update("mission", v)} error={errors && editing.mission.trim().length < 15 ? "Describe the mission in at least 15 characters." : undefined}/><Button variant="outline" onClick={() => { update("mission", blank.mission || "Qualify property inquiries, find suitable homes, and book viewings after confirming details."); }}>Use property advisor example</Button></FieldGroup> : step === 1 ? <div className="stack">{configuration("Identity")}{configuration("Conversation")}{configuration("Tools & channels")}</div> : <div className="review-summary"><h3>{editing.name}</h3><p>{editing.mission}</p><Separator /><p>{editing.personality} · {editing.voice} · {editing.language}</p><p>{editing.channels.join(" and ")}</p><p>{editing.tools.join(", ") || "No tools selected"}</p><Alert><AlertTitle>You stay in control</AlertTitle><AlertDescription>Generation prepares editable suggestions. Nothing is saved to the real product or deployed.</AlertDescription></Alert></div>}</FieldSet>
    </Panel>
    {currentJob && <JobStatus key={currentJob.id} job={currentJob} onOpen={() => openAgent(currentJob.agent.id)} onCancel={() => cancel(currentJob)} onRetry={() => enqueue(currentJob.kind, currentJob.agent)}/>}
    <div className="save-bar"><Button variant="outline" onClick={() => step > 0 ? setStep(step - 1) : go("list")}>{step > 0 ? "Back" : "Cancel"}</Button>{direction === "studio" || step === 2 ? <LoadingButton pending={busy} pendingText="Generating…" onClick={() => { if (valid())
        enqueue("generate"); }}>Generate draft</LoadingButton> : <Button onClick={() => { if (valid()) {
        setErrors(false);
        setStep(step + 1);
    } }}>Next<ArrowRight data-icon="inline-end"/></Button>}</div>
  </div>;
    const editContent = <>
    <div className="detail-status"><Badge variant="outline">{model.agents.find((a) => a.id === editing.id)?.status || "Draft"}</Badge><p>{persistedStatus === "Draft" ? "Review and save this draft, then deploy when you are ready." : "Test your changes before deploying them."}</p><Button variant="outline" onClick={() => { setShowTest(true); setTimeout(() => { const panel = document.getElementById("prototype-test-panel"); panel?.scrollIntoView({ behavior: "instant", block: "start" }); panel?.focus(); }, 0); }}>Test this agent</Button></div>
    {currentJob && <JobStatus key={currentJob.id} job={currentJob} onOpen={() => setNotice(jobMessage(currentJob))} onCancel={() => cancel(currentJob)} onRetry={() => enqueue(currentJob.kind, currentJob.agent)}/>}
    <div className={cn("editor-layout", direction)}><div className="config-stack">
      {direction === "progressive" && <Panel title="Agent overview" description={editing.role}><p>{editing.mission}</p><div className="row"><Badge variant="secondary">{editing.voice}</Badge><Badge variant="secondary">{editing.language}</Badge><Badge variant="secondary">{editing.tools.length} tools</Badge></div></Panel>}
      {parts.map((part) => direction === "progressive" ? <Panel key={part} title={part} description={sectionDescriptions[part]} footer={<Button variant="ghost" aria-expanded={section === part} onClick={() => setSection(section === part ? null : part)}>{section === part ? `Close ${part}` : `Edit ${part}`}<ArrowRight data-icon="inline-end"/></Button>}>{section === part ? configuration(part) : <p>{part === "Identity" ? `${editing.name} · ${editing.personality}` : part === "Mission" ? editing.greeting : part === "Conversation" ? `${editing.voice} · ${editing.language}` : `${editing.tools.length} tools · ${editing.channels.join(", ")}`}</p>}</Panel> : <Panel key={part} title={part} description={sectionDescriptions[part]}>{configuration(part)}</Panel>)}
      <Panel title={persistedStatus === "Draft" ? "Discard this draft" : "Delete agent"} description={persistedStatus === "Draft" ? "Remove this generated draft without deploying it." : "Call history stays. Assigned numbers are released and pending work is cancelled."}><Button variant="destructive" disabled={busy} onClick={() => openDialog(persistedStatus === "Draft" ? "discard" : "delete")}><Trash2 data-icon="inline-start"/>{persistedStatus === "Draft" ? "Discard draft" : "Delete agent"}</Button></Panel>
    </div><aside id="prototype-test-panel" tabIndex={-1} className="test-rail">{direction === "progressive" && <Button variant="outline" onClick={() => setShowTest(!showTest)} aria-expanded={showTest}><Phone data-icon="inline-start"/>{showTest ? "Collapse test panel" : "Test this agent"}</Button>}{(direction !== "progressive" || showTest) && <TestPanel key={editing.id} agent={editing} onNotice={setNotice}/>}</aside></div>
    <div className="save-bar"><span>{dirty ? "Unsaved changes" : busy ? "Work accepted · see Jobs" : "All changes saved"}</span><div className="row"><LoadingButton pending={busy && currentJob?.kind === "save"} pendingText="Saving…" variant="outline" disabled={busy} onClick={() => { if (valid())
        enqueue("save"); }}>{persistedStatus === "Draft" ? "Save draft" : "Save changes"}</LoadingButton><LoadingButton pending={busy && currentJob?.kind !== "save"} pendingText="Working…" disabled={busy || dirty || persistedStatus === "Draft" || !editing.name.trim() || editing.mission.trim().length < 15} onClick={() => enqueue("deploy")}>Deploy agent</LoadingButton></div></div>
  </>;
    return <>
    <header className="prototype-topbar"><div className="row"><Button variant="ghost" onClick={() => navigate(() => { window.location.hash = ""; })}><ArrowLeft data-icon="inline-start"/>Compare</Button><span className="brand">voni</span><span className="direction-title">{directions[direction].title}</span></div><Badge variant="outline">Simulated prototype</Badge></header>
    <div className="workspace-shell"><nav className="workspace-nav" aria-label="Prototype navigation"><Button variant={screen === "list" || screen === "edit" || screen === "create" ? "secondary" : "ghost"} onClick={() => go("list")}>Agents</Button><Button variant={screen === "browse" ? "secondary" : "ghost"} onClick={() => go("browse")}>Overview</Button><Button variant={screen === "jobs" ? "secondary" : "ghost"} onClick={() => go("jobs")}>Jobs {active.length > 0 && <Badge>{active.length}</Badge>}</Button><Button variant={screen === "components" ? "secondary" : "ghost"} onClick={() => go("components")}>Components</Button><Button variant="outline" onClick={() => setScenario(true)}>Scenarios</Button></nav>
    <div className={cn("workspace-content", direction === "studio" && "with-navigator")}>
      {direction === "studio" && <aside className="studio-navigator"><div className="row"><h2>Your agents</h2><Badge variant="secondary">{model.agents.length}</Badge></div><Button variant="outline" onClick={create}><Plus data-icon="inline-start"/>New agent</Button>{model.agents.map((a) => <Button variant={editing.id === a.id && screen === "edit" ? "secondary" : "ghost"} key={a.id} onClick={() => navigate(() => openAgent(a.id))}><span className="navigator-label">{a.name}<small>{a.status}</small></span></Button>)}{!model.agents.length && <p>No agents yet.</p>}</aside>}
      <main className="workspace-main"><header className="page-heading"><h1 ref={heading} tabIndex={-1}>{title}</h1>{screen === "edit" && <p>{editing.role}</p>}{screen === "list" && <p>Build a team that knows what to do next.</p>}</header>
      {storageError && <Alert variant="destructive"><AlertTitle>Browser storage unavailable</AlertTitle><AlertDescription>Work was not accepted. Allow local storage and try again.</AlertDescription></Alert>}
      {notice && <div className="notice" role="status"><p>{notice}</p><Button variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></div>}
      {screen !== "jobs" && model.jobs[0]?.status === "succeeded" && <div className="completion" role="status"><Check /><span>{model.jobs[0].agent.name}: {jobMessage(model.jobs[0])}</span><Button variant="outline" onClick={() => navigate(() => model.jobs[0].kind === "delete" ? setScreen("list") : openAgent(model.jobs[0].agent.id))}>View result</Button></div>}
      {screen === "list" && listContent}{screen === "create" && createContent}{screen === "edit" && editContent}
      {screen === "jobs" && <div className="stack"><p>Only this prototype browser profile sees these jobs. Reload or leave this page; completed work will be reconciled when you return.</p>{model.jobs.length ? model.jobs.map((j) => <JobStatus key={j.id} job={j} onOpen={() => j.kind === "delete" ? setScreen("list") : openAgent(j.agent.id)} onCancel={() => cancel(j)} onRetry={() => enqueue(j.kind, j.agent)}/>) : <Empty><EmptyHeader><EmptyTitle>No background work yet</EmptyTitle><EmptyDescription>Generate a draft or deploy an agent to see progress here.</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={create}>Create agent</Button></EmptyContent></Empty>}</div>}
      {screen === "browse" && <Panel title="Your workspace, at a glance" description="A sample destination for checking completion away from the editor."><p>You can browse while your agent is being prepared. The Jobs control stays available on every screen.</p><div className="overview-agents">{model.agents.map((a) => <div className="overview-row" key={a.id}><strong>{a.name}</strong><span>{a.role}</span><Badge variant="outline">{a.status}</Badge><Button variant="ghost" onClick={() => openAgent(a.id)}>Open {a.name}</Button></div>)}</div></Panel>}
      {screen === "components" && <Specimen onNotice={setNotice}/>}
      </main>
    </div></div>
    <Dialog open={scenario} onOpenChange={setScenario}><DialogContent><DialogHeader><DialogTitle>Prototype scenarios</DialogTitle><DialogDescription>These controls affect sample data only. Choose an outcome for the next operation.</DialogDescription></DialogHeader><Choices label="Operation outcome" options={["Success", "Failure", "Rate limited", "Permission blocked"]} value={[{ success: "Success", failure: "Failure", "rate-limited": "Rate limited", "permission-blocked": "Permission blocked" }[outcome]]} onChange={(v) => setOutcome(({ Success: "success", Failure: "failure", "Rate limited": "rate-limited", "Permission blocked": "permission-blocked" } as Record<string, Outcome>)[v[0]])}/><p>Vera is used by “September viewings” and cannot be deleted. Leo can be deleted. Mina is an editable draft.</p><DialogFooter><Button variant="outline" onClick={() => { setScenario(false); openDialog("reset"); }}>Reset sample data</Button><Button onClick={() => setScenario(false)}>Done</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open)
        closeDialog(); }}><DialogContent><DialogHeader><DialogTitle>{dialog === "leave" ? "Leave with unsaved changes?" : dialog === "reset" ? "Reset this prototype?" : dialog === "discard" ? `Discard ${editing.name}?` : `Delete ${editing.name}?`}</DialogTitle><DialogDescription>{dialog === "leave" ? "Your last saved version will remain. Changes made since then will be lost." : dialog === "reset" ? "This clears this direction’s sample agents and jobs. Your real workspace is unaffected." : editing.campaign ? `${editing.name} is used by “${editing.campaign}”. Remove that campaign before deleting this agent.` : "This removes the sample agent, releases number assignments, and cancels pending work. Call history is retained. This cannot be undone within this prototype."}</DialogDescription></DialogHeader>
      {(dialog === "delete" || dialog === "discard") && !editing.campaign && <TextField label="Type agent name to confirm" value={typedName} onChange={setTypedName} hint={editing.name}/>}
      <DialogFooter><Button variant="outline" onClick={closeDialog}>{dialog === "leave" ? "Keep editing" : "Cancel"}</Button>{dialog === "leave" ? <Button variant="destructive" onClick={() => { closeDialog(); pendingNavigation.current(); }}>Leave without saving</Button> : dialog === "reset" ? <><Button variant="outline" onClick={() => reset(true)}>Start empty</Button><Button onClick={() => reset()}>Restore samples</Button></> : <Button variant="destructive" disabled={Boolean(editing.campaign) || typedName !== editing.name || busy} onClick={() => enqueue("delete")}>{dialog === "discard" ? "Discard draft" : "Delete permanently"}</Button>}</DialogFooter></DialogContent></Dialog>
  </>;
}
function JobStatus({ job, onOpen, onCancel, onRetry }: {
    job: Job;
    onOpen: () => void;
    onCancel: () => void;
    onRetry: () => void;
}) {
    const [background, setBackground] = useState(() => Date.now() - job.started >= 3000);
    useEffect(() => { const timer = setTimeout(() => setBackground(true), Math.max(0, job.started + 3000 - Date.now())); return () => clearTimeout(timer); }, [job.started]);
    return <Panel title={`${jobLabel(job)} · ${job.agent.name}`} description={`Prototype job · ${job.id.slice(0, 8)}`} footer={<div className="row">{isActive(job) ? <Button variant="outline" onClick={onCancel}>Cancel job</Button> : job.status === "succeeded" ? <Button variant="outline" onClick={onOpen}>{job.kind === "delete" ? "Back to agents" : "Open result"}</Button> : <Button variant="outline" onClick={onRetry}>Retry {jobLabel(job).toLowerCase()}</Button>}</div>}><div className="stack"><Badge variant={job.status === "failed" ? "destructive" : "secondary"}>{job.status.replaceAll("-", " ")}</Badge>{isActive(job) && <Progress aria-label={`${jobLabel(job)} progress`} value={null}/>}<p>{isActive(job) && !background ? "Accepted. Preparing your request…" : jobMessage(job)}</p></div></Panel>;
}
function TestPanel({ agent, onNotice }: {
    agent: Agent;
    onNotice: (v: string) => void;
}) {
    const [state, setState] = useState("Idle");
    const [failure, setFailure] = useState("None");
    const [sessionAgent, setSessionAgent] = useState(agent);
    useEffect(() => { if (state !== "Connecting")
        return; const timer = setTimeout(() => setState(failure === "None" ? "Listening" : failure), 1000); return () => clearTimeout(timer); }, [state, failure]);
    return <Panel title="Test this agent" description="A simulated conversation. No microphone or real call." footer={<p>Edits are used for the next simulated session.</p>}><div className="test-content"><div className="test-avatar" aria-hidden="true">{agent.name[0] || "V"}</div><h3>{agent.name || "Your agent"}</h3><p>{agent.role}</p><Badge variant="outline">{state}</Badge>{state === "Listening" || state === "Speaking" ? <><p className="sample-utterance">{state === "Listening" ? sessionAgent.greeting : "I can help with that. What area and budget do you have in mind?"}</p><Button variant="outline" onClick={() => setState(state === "Listening" ? "Speaking" : "Listening")}>{state === "Listening" ? "Simulate customer reply" : "Continue conversation"}</Button><Button variant="destructive" onClick={() => setState("Ended")}>End test call</Button></> : <>{state === "Ended" && <p>Test ended. No booking was made and no lead was changed.</p>}{["Mic denied", "Rate limited", "Disconnected"].includes(state) && <Alert variant="destructive"><AlertTitle>{state}</AlertTitle><AlertDescription>{state === "Mic denied" ? "Microphone permission was denied in this scenario. Choose None below to simulate granting access." : state === "Rate limited" ? "Calling is temporarily limited in this scenario. Choose None and retry." : "The simulated connection dropped. Your configuration is safe; start a new test."}</AlertDescription></Alert>}<LoadingButton pending={state === "Connecting"} pendingText="Connecting…" onClick={() => { setSessionAgent(structuredClone(agent)); setState("Connecting"); onNotice("Simulated test started. No microphone or external service is used."); }}><Phone data-icon="inline-start"/>{state === "Idle" ? "Start test call" : "Start new test"}</LoadingButton></>}<Separator /><Choices label="Simulated call outcome" options={["None", "Mic denied", "Rate limited", "Disconnected"]} value={[failure]} onChange={(v) => setFailure(v[0])}/></div></Panel>;
}
function Specimen({ onNotice }: {
    onNotice: (v: string) => void;
}) {
    const [name, setName] = useState("Vera");
    const [mission, setMission] = useState("");
    const [dialog, setDialog] = useState(false);
    return <div className="specimen-grid"><Panel title="Actions" description="Rounded controls with clear priority."><div className="row"><Button onClick={() => onNotice("Changes saved in this specimen.")}>Save changes</Button><Button variant="outline" onClick={() => onNotice("Secondary action selected.")}>Preview</Button><Button variant="destructive" onClick={() => setDialog(true)}>Delete</Button><LoadingButton pending pendingText="Saving…">Save</LoadingButton><Button disabled>Unavailable</Button></div></Panel><Panel title="Fields" description="Labels, hints, and validation stay together."><FieldGroup><TextField label="Specimen agent name" value={name} onChange={setName} error={!name ? "Enter an agent name." : undefined} hint="A short name customers can remember."/><TextField label="Invalid mission example" value={mission} onChange={setMission} error={mission.length < 15 ? "Describe the mission in at least 15 characters." : undefined}/></FieldGroup></Panel><Panel title="Status labels" description="State is always expressed in text."><div className="row">{["Draft", "Ready", "Queued", "Running", "Succeeded", "Failed", "Cancelled", "Rate limited", "Permission blocked"].map((s) => <Badge variant={s === "Failed" ? "destructive" : "outline"} key={s}>{s}</Badge>)}</div></Panel><Panel title="Notifications" description="Immediate feedback, with a way forward."><Alert><AlertTitle>Draft ready for review</AlertTitle><AlertDescription>Review the mission and test the conversation before deploying.</AlertDescription></Alert><Button variant="outline" onClick={() => onNotice("Your draft is ready. Open it from Jobs.")}>Show notification</Button></Panel><Panel title="Confirmation dialog" description="Explicit consequences and a safe way back."><Button variant="outline" onClick={() => setDialog(true)}>Open confirmation</Button></Panel><div className="save-bar specimen-save"><span>Unsaved changes</span><Button onClick={() => onNotice("Specimen changes saved.")}>Save changes</Button></div><Dialog open={dialog} onOpenChange={setDialog}><DialogContent><DialogHeader><DialogTitle>Delete this sample?</DialogTitle><DialogDescription>This is a specimen dialog. No agent will be removed. Escape and Cancel return you to the specimen.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDialog(false)}>Cancel</Button><Button variant="destructive" onClick={() => { setDialog(false); onNotice("Sample deletion confirmed."); }}>Confirm deletion</Button></DialogFooter></DialogContent></Dialog></div>;
}
