import { Home } from "lucide-react";
import type { TenantConfig } from "@blackrock-ai/agent-core";

export const blackrockConfig: TenantConfig = {
  id: "blackrock",
  brand: "BlackRock AI",
  product: "BlackRock AI Workspace",
  tagline: "AI workspace",
  accent: "#1F6FEB",
  nav: [{ id: "home", label: "Home", Icon: Home }],
  categories: [],
};

export const tenantConfig = blackrockConfig;
