/**
 * Emoji reactions as a control surface.
 *
 * Reactions arrive as ordinary Events API events, so this adds no interactive-component
 * surface and stays behind the same signature check and allowlist as a mention. The one
 * thing a `reaction_added` payload does NOT carry is `thread_ts` - see `resolveThreadTs`
 * in ./api.ts for how the thread is recovered.
 */

export type ControlAction =
  | "interrupt"
  | "fork"
  | "archive"
  | "retry"
  | "escalate"
  | "desktop";

/**
 * Slack delivers the emoji's short name, not the character. Skin-tone variants arrive
 * suffixed (`+::skin-tone-3`), which `controlFor` strips.
 */
export const CONTROL_REACTIONS: Readonly<Record<string, ControlAction>> = {
  octagonal_sign: "interrupt", // 🛑
  fork_and_knife: "fork", // 🍴
  zzz: "archive", // 💤
  recycle: "retry", // ♻️
  brain: "escalate", // 🧠
  desktop_computer: "desktop", // 🖥️
};

export function controlFor(reaction: string): ControlAction | null {
  const base = reaction.split("::")[0] ?? reaction;
  return CONTROL_REACTIONS[base] ?? null;
}

/**
 * Reasoning effort levels. Which ones a given model accepts varies, so an unsupported
 * value is a Box API error rather than something worth encoding here.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export const EFFORT_ACTION_ID = "sark_set_effort";

/**
 * Buttons on the status message. `action_id` has to be unique within a block, so each
 * control gets its own rather than sharing one id and switching on `value`.
 */
export const BUTTON_ACTIONS: Readonly<Record<string, ControlAction>> = {
  sark_interrupt: "interrupt",
  sark_retry: "retry",
  sark_escalate: "escalate",
  sark_fork: "fork",
  sark_desktop: "desktop",
  sark_archive: "archive",
};

export function buttonAction(actionId: string): ControlAction | null {
  return BUTTON_ACTIONS[actionId] ?? null;
}

/** Whether the run is still going, which decides what is worth offering. */
export type StatusPhase = "working" | "done";

function button(
  actionId: string,
  label: string,
  opts: { style?: "primary" | "danger"; confirm?: { title: string; text: string; ok: string } } = {},
): Record<string, unknown> {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: label },
    ...(opts.style ? { style: opts.style } : {}),
    ...(opts.confirm
      ? {
          // Slack renders this natively, so a destructive control costs a deliberate
          // second click without us holding any pending-confirmation state.
          confirm: {
            title: { type: "plain_text", text: opts.confirm.title },
            text: { type: "mrkdwn", text: opts.confirm.text },
            confirm: { type: "plain_text", text: opts.confirm.ok },
            deny: { type: "plain_text", text: "Cancel" },
          },
        }
      : {}),
  };
}

/**
 * The status message: one line of text plus the controls that make sense right now.
 * While a run is going the only useful actions are stopping it and watching it; once it
 * is over, stopping is meaningless and re-running is the point.
 */
export function statusBlocks(text: string, phase: StatusPhase): unknown[] {
  const elements =
    phase === "working"
      ? [
          button("sark_interrupt", "Stop", { style: "danger" }),
          button("sark_desktop", "Watch"),
        ]
      : [
          button("sark_retry", "Re-run"),
          button("sark_escalate", "Effort"),
          button("sark_fork", "Fork", {
            confirm: {
              title: "Fork this sandbox?",
              text: "Opens a *new thread* with a copy of this sandbox, starting from its current filesystem. The copy runs until it goes idle.",
              ok: "Fork",
            },
          }),
          button("sark_archive", "Archive", {
            confirm: {
              title: "Archive this sandbox?",
              text: "Snapshots and stops the sandbox now. The next message in this thread wakes it back up on the same filesystem.",
              ok: "Archive",
            },
          }),
        ];

  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", elements },
  ];
}

/**
 * The dropdown 🧠 / Effort posts. Selecting an option re-runs the last prompt at that
 * effort. Block Kit is the only way to offer a real picker; a single button or reaction
 * can only ever mean one fixed choice.
 */
export function effortPickerBlocks(note: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: note },
      accessory: {
        type: "static_select",
        action_id: EFFORT_ACTION_ID,
        placeholder: { type: "plain_text", text: "Reasoning effort" },
        options: EFFORT_LEVELS.map((level) => ({
          text: { type: "plain_text", text: level },
          value: level,
        })),
      },
    },
  ];
}
