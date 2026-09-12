// Prototype-only data. No product API, job runner, credentials, or microphone access.
export type Direction = "guided" | "studio" | "progressive";
export type Agent = {
    id: string;
    name: string;
    role: string;
    mission: string;
    greeting: string;
    voice: string;
    language: string;
    personality: string;
    knowledge: string;
    tasks: string;
    detect: string[];
    channels: string[];
    tools: string[];
    status: "Draft" | "Ready" | "Changes saved";
    campaign?: string;
};
export type Outcome = "success" | "failure" | "rate-limited" | "permission-blocked";
export type Job = {
    id: string;
    kind: "generate" | "deploy" | "delete" | "save";
    agent: Agent;
    started: number;
    duration: number;
    outcome: Outcome;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "rate-limited" | "permission-blocked";
};
export type Model = {
    agents: Agent[];
    jobs: Job[];
};
export const blank: Agent = {
    id: "", name: "", role: "Property advisor", mission: "", greeting: "Hello, I’m here to help you find the right property. What are you looking for?",
    knowledge: "Never quote fees or availability you cannot verify. Confirm details before booking. Transfer to a person when you cannot help.", tasks: "Ask about budget and preferred area. Search for matching homes. Offer an available viewing time.", detect: ["Budget", "Location", "Timeline"], voice: "Clara", language: "English", personality: "Warm", channels: ["Phone calls"], tools: ["Search properties", "Check availability", "Book viewing"], status: "Draft",
};
export const samples: Agent[] = [
    { ...blank, id: "vera", name: "Vera", mission: "Qualify property inquiries, find matching homes, and book a viewing. Confirm details before making a booking.", status: "Ready", campaign: "September viewings" },
    { ...blank, id: "leo", name: "Leo", role: "Follow-up specialist", mission: "Follow up with interested buyers and help them choose a viewing time.", voice: "Leo", status: "Ready" },
    { ...blank, id: "mina", name: "Mina", role: "Rental concierge", mission: "Help renters find an available home within their budget and preferred area.", status: "Draft" },
];
export const initialModel = (): Model => ({ agents: structuredClone(samples), jobs: [] });
export const isActive = (job: Job) => job.status === "queued" || job.status === "running";
export function advance(model: Model, now: number): Model {
    let changed = false;
    let agents = model.agents;
    const jobs = model.jobs.map((job): Job => {
        if (!isActive(job))
            return job;
        if (now < job.started + job.duration) {
            if (now - job.started > 1000 && job.status === "queued") {
                changed = true;
                return { ...job, status: "running" };
            }
            return job;
        }
        changed = true;
        if (job.outcome !== "success")
            return { ...job, status: job.outcome === "failure" ? "failed" : job.outcome };
        if (job.kind === "delete")
            agents = agents.filter((a) => a.id !== job.agent.id);
        else {
            const result: Agent = { ...job.agent, status: job.kind === "deploy" ? "Ready" : job.kind === "save" ? "Changes saved" : "Draft" };
            agents = [...agents.filter((a) => a.id !== result.id), result];
        }
        return { ...job, status: "succeeded" };
    });
    return changed ? { agents, jobs } : model;
}
export const jobLabel = (j: Job) => ({ generate: "Generate draft", deploy: "Deploy agent", delete: "Delete agent", save: "Save agent" })[j.kind];
export function jobMessage(j: Job) {
    if (j.status === "failed")
        return "The simulated service could not finish. Your saved agent is unchanged. Retry when ready.";
    if (j.status === "rate-limited")
        return "Too many requests in this scenario. Switch the outcome to Success and retry.";
    if (j.status === "permission-blocked")
        return "You do not have permission in this scenario. Switch the outcome to Success to simulate restored access.";
    if (j.status === "cancelled")
        return "Cancelled. Your saved agent is unchanged.";
    if (j.status === "succeeded")
        return j.kind === "delete" ? "Agent deleted. Call history retained; number assignments released." : j.kind === "generate" ? "Your draft is ready for review. Nothing has been deployed." : j.kind === "save" ? "Changes saved. Deploy when you are ready." : "Ready to receive calls. Your changes are deployed.";
    return "This is continuing in the background. You can browse Voni and return when it is ready.";
}
