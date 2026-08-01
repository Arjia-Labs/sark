import { describe, expect, it } from "vitest";

import {
  controlFor,
  effortPickerBlocks,
  EFFORT_ACTION_ID,
  EFFORT_LEVELS,
  isEffort,
  OFFERED_REACTIONS,
  CONTROL_REACTIONS,
} from "../src/slack/controls.ts";
import { interpret, type SlackEventEnvelope } from "../src/slack/events.ts";

const BOT = "U0BOT";

function reaction(over: Record<string, unknown> = {}): SlackEventEnvelope {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    authorizations: [{ user_id: BOT, is_bot: true }],
    event: {
      type: "reaction_added",
      user: "U1",
      reaction: "octagonal_sign",
      item: { type: "message", channel: "C1", ts: "111.222" },
      ...over,
    },
  } as SlackEventEnvelope;
}

describe("control reactions", () => {
  it("maps each offered reaction to an action", () => {
    for (const name of OFFERED_REACTIONS) {
      expect(controlFor(name)).not.toBeNull();
    }
  });

  it("offers every action it knows about", () => {
    const offered = new Set(OFFERED_REACTIONS.map((n) => controlFor(n)));
    expect(offered).toEqual(new Set(Object.values(CONTROL_REACTIONS)));
  });

  it("ignores emoji that mean nothing to us", () => {
    expect(controlFor("tada")).toBeNull();
    expect(controlFor("")).toBeNull();
  });

  it("strips skin-tone variants", () => {
    expect(controlFor("fork_and_knife::skin-tone-3")).toBe("fork");
  });
});

describe("interpret(reaction_added)", () => {
  it("turns a control emoji into a control decision", () => {
    const d = interpret(reaction());
    expect(d).toMatchObject({
      kind: "control",
      action: "interrupt",
      team: "T1",
      channel: "C1",
      user: "U1",
      itemTs: "111.222",
      eventId: "Ev1",
    });
  });

  it("carries the reacted message ts, not a thread id", () => {
    // reaction_added has no thread_ts at all; resolving it is the caller's job.
    const d = interpret(reaction());
    if (d.kind !== "control") throw new Error("expected control");
    expect(d.itemTs).toBe("111.222");
    expect(d).not.toHaveProperty("threadId");
  });

  it("ignores an unrecognised emoji", () => {
    expect(interpret(reaction({ reaction: "eyes" })).kind).toBe("ignore");
  });

  it("ignores the bot reacting to itself", () => {
    // The bot seeds these same emoji as affordances.
    const d = interpret(reaction({ user: BOT }));
    expect(d).toEqual({ kind: "ignore", reason: "own reaction" });
  });

  it("ignores reactions on files rather than messages", () => {
    const d = interpret(reaction({ item: { type: "file", channel: "C1", ts: "1" } }));
    expect(d.kind).toBe("ignore");
  });

  it("ignores a reaction with no channel", () => {
    const d = interpret(reaction({ item: { type: "message", ts: "1" } }));
    expect(d).toEqual({ kind: "ignore", reason: "incomplete reaction" });
  });

  it("still reads mentions normally", () => {
    const d = interpret({
      type: "event_callback",
      team_id: "T1",
      event: { type: "app_mention", user: "U1", channel: "C1", ts: "9.9", text: "<@B> hi" },
    } as SlackEventEnvelope);
    expect(d.kind).toBe("prompt");
  });
});

describe("effort picker", () => {
  it("accepts only known effort levels", () => {
    for (const level of EFFORT_LEVELS) expect(isEffort(level)).toBe(true);
    expect(isEffort("turbo")).toBe(false);
    expect(isEffort(undefined)).toBe(false);
  });

  it("builds a select carrying every level under the expected action id", () => {
    const [block] = effortPickerBlocks("pick one") as {
      accessory: { action_id: string; options: { value: string }[] };
    }[];
    expect(block?.accessory.action_id).toBe(EFFORT_ACTION_ID);
    expect(block?.accessory.options.map((o) => o.value)).toEqual([...EFFORT_LEVELS]);
  });
});
