import { validateSession, type Session } from "./auth";
import { formatName } from "./utils/format";

export function handle(session: Session): string {
  if (!validateSession(session, Date.now())) {
    return "denied";
  }
  return formatName(session.userId);
}
