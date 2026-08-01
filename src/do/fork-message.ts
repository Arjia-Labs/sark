/**
 * What the bot says in a freshly forked thread. Posted before the box exists (the thread
 * has to be named first) and rewritten once it does, so it is built in one place from
 * whatever is known at the time.
 */
export function forkAnnouncement(o: { actor?: string; sourceLink: string | null; boxId?: string }): string {
  const who = o.actor ? `<@${o.actor}>` : "Someone";
  const source = o.sourceLink ? `<${o.sourceLink}|another thread>` : "another thread";
  const box = o.boxId ? ` \`${o.boxId}\`` : "";
  return [
    `🍴 ${who} forked ${source} into this one.${box}`,
    "",
    "This sandbox is a *copy* of that thread's filesystem, taken just now. It runs on its own — nothing you do here changes the original, and nothing there changes this.",
    "",
    "Mention me to carry on.",
  ].join("\n");
}
