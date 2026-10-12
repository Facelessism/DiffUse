import { validateSession } from "./index";
import type { Session } from "./auth";

export function check(session: Session): boolean {
  return validateSession(session);
}
