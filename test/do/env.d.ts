import type { Env } from "../../src/config.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
