export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
  ip?: string;
}

export const SESSION_TTL_MS = 3_600_000;

export function validateSession(session: Session, now: number): boolean {
  if (!session.userId) {
    return false;
  }
  return session.expiresAt > now;
}

export function refreshSession(session: Session): Session {
  return { ...session, expiresAt: Date.now() + SESSION_TTL_MS * 2 };
}

export function isExpired(session: Session): boolean {
  return session.expiresAt <= Date.now();
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  save(session: Session): void {
    this.sessions.set(session.id, session);
  }

  find(id: string): Session | undefined {
    return this.sessions.get(id) ?? undefined;
  }
}

export function legacyToken(session: Session): string {
  return session.id;
}
