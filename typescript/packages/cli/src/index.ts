export { defineConfig, file } from "./define.js";
export { ConfigError, type Desired, type DesiredScope, loadConfig, readRaw } from "./load.js";
export { EXIT, type Io, run } from "./main.js";
export { type Applied, apply, type Change, DriftError, type Plan, plan } from "./plan.js";
export { context } from "./remote.js";
export { SCHEMA_PATH, SCHEMA_URL, validate } from "./schema.js";
export type {
  ConfigFile,
  FileReference,
  Scope,
  ScopeBudgets,
  ScopeInstructions,
  ScopeTools,
  Surface,
  Text,
} from "./types.js";
