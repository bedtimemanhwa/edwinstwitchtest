// Configuration from .env (see .env.example). Secrets stay on the backend.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  webDir: string;
  assetPack: string;
  twitch: { clientId: string; clientSecret: string; redirectUri: string } | null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadConfig(root = process.cwd()): Config {
  const envFile = resolve(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const host = env.HH_HOST ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error(`HH_HOST must be a loopback address (127.0.0.1, localhost or ::1), not ${host}. The overlay and dashboard are local-only.`);
  const port = Number(env.HH_PORT ?? 3977);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`HH_PORT is not a valid port: ${env.HH_PORT}`);
  const id = env.TWITCH_CLIENT_ID?.trim(), secret = env.TWITCH_CLIENT_SECRET?.trim();
  return {
    host, port,
    dataDir: resolve(root, env.HH_DATA_DIR ?? "data"),
    webDir: resolve(root, "dist/web"),
    assetPack: resolve(root, env.HH_ASSET_PACK ?? "dist/web/pack/placeholder"),
    twitch: id && secret ? { clientId: id, clientSecret: secret, redirectUri: env.TWITCH_REDIRECT_URI?.trim() || `http://localhost:${port}/auth/callback` } : null,
  };
}
