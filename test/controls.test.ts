import { describe, expect, it } from "vitest";

import {
  buttonAction,
  BUTTON_ACTIONS,
  controlFor,
  effortPickerBlocks,
  EFFORT_ACTION_ID,
  EFFORT_LEVELS,
  isEffort,
  statusBlocks,
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

describe("status buttons", () => {
  type Btn = { action_id: string; text: { text: string }; confirm?: unknown; style?: string };
  const buttons = (phase: "working" | "done") =>
    (statusBlocks("x", phase) as { type: string; elements?: Btn[] }[]).find(
      (b) => b.type === "actions",
    )!.elements!;

  it("puts the message text in a section block", () => {
    const [section] = statusBlocks("hello", "done") as { type: string; text: { text: string } }[];
    expect(section?.type).toBe("section");
    expect(section?.text.text).toBe("hello");
  });

  it("offers stopping and watching while a run is going", () => {
    expect(buttons("working").map((b) => b.action_id)).toEqual(["sark_interrupt", "sark_desktop"]);
  });

  it("drops stop once the run is over, since it would do nothing", () => {
    const ids = buttons("done").map((b) => b.action_id);
    expect(ids).not.toContain("sark_interrupt");
    expect(ids).toEqual(["sark_retry", "sark_escalate", "sark_fork", "sark_archive"]);
  });

  it("guards the destructive controls behind a confirm dialog", () => {
    const done = buttons("done");
    for (const id of ["sark_fork", "sark_archive"]) {
      expect(done.find((b) => b.action_id === id)?.confirm).toBeDefined();
    }
    // Re-running is cheap and reversible; it should not cost a second click.
    expect(done.find((b) => b.action_id === "sark_retry")?.confirm).toBeUndefined();
  });

  it("uses unique action ids per block, which Slack requires", () => {
    for (const phase of ["working", "done"] as const) {
      const ids = buttons(phase).map((b) => b.action_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("maps every button id to a real action", () => {
    for (const phase of ["working", "done"] as const) {
      for (const b of buttons(phase)) expect(buttonAction(b.action_id)).not.toBeNull();
    }
    expect(buttonAction("sark_nonsense")).toBeNull();
  });

  it("covers the same actions as the reactions do", () => {
    expect(new Set(Object.values(BUTTON_ACTIONS))).toEqual(
      new Set(Object.values(CONTROL_REACTIONS)),
    );
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
