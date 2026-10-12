export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

export const SESSION_TTL_MS = 3_600_000;

export function validateSession(session: Session): boolean {
  return session.expiresAt > Date.now();
}

export function refreshSession(session: Session): Session {
  return { ...session, expiresAt: Date.now() + SESSION_TTL_MS };
}

function audit(message: string): void {
  console.log(message);
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  save(session: Session): void {
    this.sessions.set(session.id, session);
  }

  find(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}

export function legacyToken(session: Session): string {
  audit("legacy");
  return session.id;
}
