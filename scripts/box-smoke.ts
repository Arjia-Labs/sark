/**
 * Proves the Box API credentials and (optionally) the template box, independently
 * of the Worker, Slack, and MCP.
 *
 *   npm run smoke                      # creates a throwaway box, prompts it, stops it
 *   TEMPLATE_BOX_ID=bx_... npm run smoke
 *   KEEP=1 npm run smoke               # leave the box running
 */
import { BoxClient, PENDING_STATES, USABLE_STATES, type BoxState } from "../src/box/client.ts";
import { loadDevVars, requireVar } from "./env.ts";

const vars = loadDevVars();
const box = new BoxClient(
  requireVar("BOX_API_KEY", vars),
  process.env.BOX_BASE_URL ?? vars.BOX_BASE_URL ?? "https://ascii.dev/api/box/v1",
);

const template = process.env.TEMPLATE_BOX_ID ?? vars.TEMPLATE_BOX_ID ?? "";
const keep = process.env.KEEP === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let boxId: string;
  if (template) {
    console.log(`forking template ${template}…`);
    boxId = (await box.fork(template, { env: { SMOKE: "1" } })).id;
    await box.update(boxId, { name: "slackbot-smoke", ttlSeconds: 900 });
  } else {
    console.log("no TEMPLATE_BOX_ID; creating a fresh box…");
    boxId = (await box.create({ ttlSeconds: 900, env: { SMOKE: "1" } })).id;
  }
  console.log(`box: ${boxId}`);

  const started = Date.now();
  let state: BoxState = "init";
  while (Date.now() - started < 180_000) {
    state = (await box.get(boxId)).state;
    if (USABLE_STATES.includes(state)) break;
    if (!PENDING_STATES.includes(state)) throw new Error(`box entered ${state}`);
    process.stdout.write(`\r  state=${state} (${Math.round((Date.now() - started) / 1000)}s)   `);
    await sleep(2000);
  }
  console.log(`\nready in ${Math.round((Date.now() - started) / 1000)}s (state=${state})`);

  const cmd = await box.command(boxId, "whoami && pwd && which claude codex");
  console.log("command:", { exitCode: cmd.exitCode, stdout: cmd.stdout.trim() });

  const provider = process.env.BOX_PROVIDER ?? "claude-code";
  console.log(`prompting via ${provider}…`);
  const queued = await box.prompt(boxId, {
    provider,
    prompt: "Write the word 'banana' into smoke.txt in the current directory, then tell me you did it.",
  });
  console.log("promptId:", queued.promptId);

  const promptStart = Date.now();
  while (Date.now() - promptStart < 300_000) {
    const run = await box.promptStatus(boxId, queued.promptId);
    process.stdout.write(`\r  prompt=${run.status} (${Math.round((Date.now() - promptStart) / 1000)}s)   `);
    if (run.done || run.status === "finished" || run.status === "failed") {
      console.log(`\nprompt ${run.status}`);
      break;
    }
    await sleep(3000);
  }

  const page = await box.events(boxId, { sort: "asc", type: "prompt,response", limit: 200 });
  const replies = page.events.filter((e) => e.type === "response" && e.data?.content);
  console.log(`\n--- ${replies.length} response event(s) ---`);
  for (const e of replies.slice(-3)) console.log(String(e.data?.content).slice(0, 800));

  try {
    const file = await box.readFile(boxId, "smoke.txt");
    console.log(`\nsmoke.txt (${file.size}B):`, JSON.stringify(file.content.trim()));
  } catch (err) {
    console.log("\nsmoke.txt not readable:", (err as Error).message.slice(0, 200));
  }

  if (keep) {
    console.log(`\nKEEP=1, leaving ${boxId} running.`);
  } else {
    await box.stop(boxId);
    console.log(`\nstopped ${boxId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
