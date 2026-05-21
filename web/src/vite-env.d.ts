/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_DEMO_MODE: string;
  readonly VITE_CC_FUNCTIONS_URL?: string;
  readonly VITE_CC_ACCESS_REQUIRED?: string;
  readonly VITE_CC_READ_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
