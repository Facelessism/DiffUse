import { refreshSession, validateSession, SessionStore } from "./auth";
import * as format from "./utils/format";

const store = new SessionStore();

export function renew(id: string): string {
  const session = store.find(id);
  if (session && validateSession(session)) {
    store.save(refreshSession(session));
  }
  return format.formatName(id);
}
