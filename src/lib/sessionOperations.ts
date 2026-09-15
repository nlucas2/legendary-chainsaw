export class SessionOperations {
  private pending = new Map<string, { token: symbol; value: string }>();

  start(sessionId: string, value: string): symbol | undefined {
    if (this.pending.has(sessionId)) return undefined;
    const token = Symbol(sessionId);
    this.pending.set(sessionId, { token, value });
    return token;
  }

  finish(sessionId: string, token: symbol): boolean {
    if (this.pending.get(sessionId)?.token !== token) return false;
    this.pending.delete(sessionId);
    return true;
  }

  get(sessionId: string): string | undefined {
    return this.pending.get(sessionId)?.value;
  }
}
