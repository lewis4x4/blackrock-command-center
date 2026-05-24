// In your top-level route (e.g. app/page.tsx for Next.js App Router, or src/App.tsx for Vite):
import { Workspace } from "@blackrock-ai/agent-core";
import { tenantConfig } from "./agent.config";

export default function Page() {
  return <Workspace config={tenantConfig} />;
}
