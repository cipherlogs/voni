import { notFound } from "next/navigation";
import AgentFlowPrototypes from "./prototype";

export default function AgentPrototypePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AgentFlowPrototypes />;
}
