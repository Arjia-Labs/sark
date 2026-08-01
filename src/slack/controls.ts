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

/** The affordances the bot seeds on its own status message, in display order. */
export const OFFERED_REACTIONS: readonly string[] = [
  "octagonal_sign",
  "recycle",
  "brain",
  "fork_and_knife",
  "desktop_computer",
  "zzz",
];

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
 * The dropdown 🧠 posts. Selecting an option re-runs the last prompt at that effort.
 * Block Kit is the only way to offer a real picker; a reaction can only ever be a
 * single fixed choice.
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
