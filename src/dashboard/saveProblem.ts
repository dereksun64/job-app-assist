import type { DbError } from "./db.ts";

/**
 * Why a change the Candidate made on the dashboard was not saved, in words they can act on.
 * Every save on the page reports its failure through this one function, so a full database
 * always comes with the way to make room: Tidy, which the Candidate starts from chat.
 */
export function saveProblem(error: unknown): string {
  const { code, message } = (error ?? {}) as Partial<DbError>;
  if (code === "quota_exceeded") {
    if (typeof message === "string" && /organi[sz]ation/i.test(message)) {
      return "Your organization's claude.ai storage for dashboards is full, so this change wasn't saved. Ask your claude.ai admin to make room.";
    }
    return "Your dashboard storage is full, so this change wasn't saved. To make room, ask your Claude to run /job-app-assist:tidy.";
  }
  if (code === "resource_exhausted") {
    return "Too many changes at once, so this one wasn't saved. Wait a moment and try again.";
  }
  if (code === "invalid_argument" && message) {
    return `This change wasn't saved: ${message}`;
  }
  return "This change wasn't saved because your dashboard data can't be reached. Try again in a moment.";
}
