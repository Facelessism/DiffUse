import { validateSession, type Session } from "./auth";
import { formatName } from "./utils/format";

export function handle(session: Session): string {
  if (!validateSession(session)) {
    return "denied";
  }
  return formatName(session.userId);
}
