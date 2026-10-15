import type { ConfigFile, FileReference } from "./types.js";

/** Type-check a configuration file. Returns it unchanged. */
export function defineConfig(config: ConfigFile): ConfigFile {
  return config;
}

/** Load a value from a file, relative to the configuration file. */
export function file(path: string): FileReference {
  return { $file: path };
}
