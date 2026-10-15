// API keys: TWIGG_API_KEY, or a named profile in ~/.config/twigg/credentials:
//
//   [default]
//   api_key = tw_...
//
//   [staging]
//   api_key = tw_...
//   base_url = https://staging.example
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  apiKey?: string;
  baseURL?: string;
}

export function credentialsPath(env: Record<string, string | undefined>): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "twigg", "credentials");
}

/** The profile's key and base URL; the environment wins when no profile is named. */
export async function resolveCredentials(
  profile: string | undefined,
  env: Record<string, string | undefined>,
): Promise<Credentials> {
  const named = profile ?? env.TWIGG_PROFILE;
  if (!named && env.TWIGG_API_KEY)
    return { apiKey: env.TWIGG_API_KEY, baseURL: env.TWIGG_BASE_URL };
  const path = credentialsPath(env);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${error.message}`);
  });
  const profiles = text ? parseIni(text) : undefined;
  const chosen = profiles?.[named ?? "default"];
  if (named && !chosen) throw new Error(`No profile "${named}" in ${path}`);
  // A profile's key and host travel together, so a profile naming only a host never sends the
  // environment's key there.
  if (chosen) return { apiKey: chosen.api_key, baseURL: chosen.base_url };
  return { apiKey: env.TWIGG_API_KEY, baseURL: env.TWIGG_BASE_URL };
}

export function parseIni(text: string): Record<string, Record<string, string>> {
  // Null prototypes, so a profile named "constructor" or "__proto__" is only ever data.
  const sections: Record<string, Record<string, string>> = Object.create(null);
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1]) {
      current = Object.create(null) as Record<string, string>;
      sections[header[1].trim()] = current;
      continue;
    }
    const eq = line.indexOf("=");
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}
