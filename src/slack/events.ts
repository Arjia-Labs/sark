import type { PromptRequest } from "../do/ThreadSession.ts";
import { stripMention } from "../prompt.ts";
import { controlFor, type ControlAction } from "./controls.ts";

export interface SlackEventEnvelope {
  type: "url_verification" | "event_callback" | string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackEvent;
  authorizations?: { user_id?: string; is_bot?: boolean }[];
}

export interface SlackEvent {
  type: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
  /** reaction_added only: the emoji short name. */
  reaction?: string;
  /** reaction_added only: what was reacted to. Carries no `thread_ts`. */
  item?: { type?: string; channel?: string; ts?: string };
}

/** Durable Object name for a Slack thread. Stable across the whole conversation. */
export function slackThreadId(teamId: string, channel: string, threadTs: string): string {
  return `${teamId}:${channel}:${threadTs}`;
}

export type Interpreted =
  | { kind: "ignore"; reason: string }
  | {
      kind: "prompt";
      threadId: string;
      team: string;
      channel: string;
      user: string;
      request: PromptRequest;
    }
  | {
      kind: "control";
      action: ControlAction;
      team: string;
      channel: string;
      user: string;
      /**
       * ts of the message that was reacted to. It is NOT the thread id: a reaction
       * payload has no `thread_ts`, so the caller resolves the thread from this.
       */
      itemTs: string;
      eventId?: string;
    };

/**
 * Decide what to do with an incoming Slack event. Pure, so it is straightforward
 * to test against captured payloads.
 */
export function interpret(envelope: SlackEventEnvelope): Interpreted {
  const event = envelope.event;
  if (!event) return { kind: "ignore", reason: "no event" };

  // Never react to ourselves or to edits/joins/etc.
  if (event.bot_id) return { kind: "ignore", reason: "bot message" };
  if (event.subtype) return { kind: "ignore", reason: `subtype ${event.subtype}` };

  if (event.type === "reaction_added") return interpretReaction(envelope, event);

  const isMention = event.type === "app_mention";
  const isDm = event.type === "message" && event.channel_type === "im";
  if (!isMention && !isDm) return { kind: "ignore", reason: `type ${event.type}` };

  const team = envelope.team_id ?? event.team;
  const channel = event.channel;
  const user = event.user;
  const ts = event.ts;
  if (!team || !channel || !user || !ts) return { kind: "ignore", reason: "incomplete event" };

  const text = isMention ? stripMention(event.text ?? "") : (event.text ?? "").trim();
  if (!text) return { kind: "ignore", reason: "empty message" };

  // Reply in the thread the user started; a top-level mention starts one.
  const threadTs = event.thread_ts ?? ts;

  const threadId = slackThreadId(team, channel, threadTs);

  return {
    kind: "prompt",
    threadId,
    team,
    channel,
    user,
    request: {
      threadId,
      text,
      user,
      transport: "slack",
      eventId: envelope.event_id,
      timestamp: new Date(Number(ts) * 1000).toISOString(),
      slack: { team, channel, threadTs, triggerTs: ts },
    },
  };
}

/**
 * A reaction on any message in a thread is a control command. Only the emoji in
 * `CONTROL_REACTIONS` mean anything; everything else is ordinary workspace chatter and
 * is ignored, which is what keeps the added `reactions:read` scope from being noisy.
 */
function interpretReaction(envelope: SlackEventEnvelope, event: SlackEvent): Interpreted {
  const action = controlFor(event.reaction ?? "");
  if (!action) return { kind: "ignore", reason: `reaction ${event.reaction}` };

  // The bot seeds these same emoji as affordances; reacting to our own reaction would
  // otherwise re-trigger the action on every restart.
  const selfIds = (envelope.authorizations ?? []).filter((a) => a.is_bot).map((a) => a.user_id);
  if (event.user && selfIds.includes(event.user)) {
    return { kind: "ignore", reason: "own reaction" };
  }

  if (event.item?.type && event.item.type !== "message") {
    return { kind: "ignore", reason: `reaction on ${event.item.type}` };
  }

  const team = envelope.team_id ?? event.team;
  const channel = event.item?.channel;
  const user = event.user;
  const itemTs = event.item?.ts;
  if (!team || !channel || !user || !itemTs) {
    return { kind: "ignore", reason: "incomplete reaction" };
  }

  return { kind: "control", action, team, channel, user, itemTs, eventId: envelope.event_id };
}

/** `stop` / `cancel` as the entire message means "interrupt the current run". */
export function isInterruptCommand(text: string): boolean {
  return /^(stop|cancel|abort|halt)[.!]?$/i.test(text.trim());
}
