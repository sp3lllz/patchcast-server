import type { ServerResponse } from "node:http";

interface Client { userId: number; deviceId: string; res: ServerResponse }

/** Server-sent events, per user. */
export class Events {
  private clients = new Set<Client>();
  private timer = setInterval(() => { for (const c of this.clients) c.res.write(": ping\n\n"); }, 20_000);
  constructor() { this.timer.unref(); }

  add(userId: number, deviceId: string, res: ServerResponse): boolean {
    const mine = [...this.clients].filter((c) => c.userId === userId);
    if (mine.length >= 50) return false;
    const c = { userId, deviceId, res };
    this.clients.add(c);
    res.on("close", () => this.clients.delete(c));
    return true;
  }
  send(userId: number, event: string, data: unknown) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) if (c.userId === userId) c.res.write(msg);
  }
  /** Ends streams of revoked devices / deleted users at once. */
  drop(match: (c: { userId: number; deviceId: string }) => boolean) {
    for (const c of [...this.clients]) if (match(c)) { this.clients.delete(c); c.res.end(); }
  }
  count() { return this.clients.size; }
  close() { clearInterval(this.timer); this.drop(() => true); }
}
