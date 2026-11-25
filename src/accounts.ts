import type { Config } from "./config.ts";
import type { Db, Row } from "./db.ts";
import { AuthError, type Principal } from "./auth.ts";
import { OidcError, deriveUsername, type Identity } from "./oidc.ts";

/** Which local account a verified identity belongs to, and who may still use a password. */
export class Accounts {
  private db: Db;
  private config: Config;
  constructor(db: Db, config: Config) { this.db = db; this.config = config; }

  private get issuer() { return this.config.oidc?.issuer ?? ""; }
  private adminCount() { return (this.db.get("SELECT COUNT(*) n FROM users WHERE is_admin=1") as Row).n as number; }

  /**
   * OIDC_PASSWORD_LOGIN=false only takes effect once an administrator has actually signed in with (or linked) the
   * configured provider, so a wrong configuration can't lock everybody out.
   */
  passwordLoginEnabled(): boolean {
    const o = this.config.oidc;
    return !o || o.passwordLogin || !this.db.get("SELECT 1 FROM identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=? AND u.is_admin=1", o.issuer);
  }
  /** `set-password` re-opens password sign-in for that one user for a day. */
  passwordLoginFor(username: string): boolean {
    return this.passwordLoginEnabled() || !!this.db.get("SELECT 1 FROM users WHERE username=? AND pw_recovery_until>?", username, Date.now());
  }
  showPasswordForm(): boolean {
    return this.passwordLoginEnabled() || !!this.db.get("SELECT 1 FROM users WHERE pw_recovery_until>?", Date.now());
  }

  private checkGroups(id: Identity) {
    const allowed = this.config.oidc!.allowedGroups;
    if (allowed.length && !allowed.some((g) => id.groups.includes(g))) throw new OidcError("not_allowed", "not in an allowed group");
  }
  private wantsAdmin(id: Identity): boolean | null {
    const groups = this.config.oidc!.adminGroups;
    return groups.length ? groups.some((g) => id.groups.includes(g)) : null;
  }
  private remember(id: Identity, userId: number) {
    const now = Date.now();
    this.db.run("UPDATE identities SET username=?, email=?, last_login_at=? WHERE issuer=? AND sub=?", id.preferredUsername, id.email, now, id.issuer, id.sub);
    if (id.name) this.db.run("UPDATE users SET display_name=? WHERE id=?", id.name, userId);
  }

  /** Finds or creates the account for an identity, strictly by (issuer, sub). */
  signIn(id: Identity): { userId: number; created: boolean } {
    this.checkGroups(id);
    return this.db.tx(() => {
      const wantsAdmin = this.wantsAdmin(id);
      let userId = this.db.get("SELECT user_id FROM identities WHERE issuer=? AND sub=?", id.issuer, id.sub)?.user_id as number | undefined;
      const created = userId === undefined;
      if (userId === undefined) {
        if (!this.config.oidc!.autoCreate) throw new OidcError("no_account", "no linked account");
        // The very first account must be an administrator, or nobody could ever administer the server.
        if (!this.db.get("SELECT 1 FROM users") && !wantsAdmin) throw new OidcError("setup_first", "server not set up");
        const username = deriveUsername(id, (u) => !!this.db.get("SELECT 1 FROM users WHERE username=?", u));
        userId = Number(this.db.run("INSERT INTO users(username,pw_hash,is_admin,created_at) VALUES(?,'',?,?)", username, wantsAdmin ? 1 : 0, Date.now()).lastInsertRowid);
        this.db.run("INSERT INTO identities(issuer,sub,user_id,linked_at) VALUES(?,?,?,?)", id.issuer, id.sub, userId, Date.now());
      } else if (wantsAdmin !== null) {
        const isAdmin = !!this.db.get("SELECT is_admin FROM users WHERE id=?", userId)!.is_admin;
        if (wantsAdmin !== isAdmin && (wantsAdmin || this.adminCount() > 1)) this.db.run("UPDATE users SET is_admin=? WHERE id=?", wantsAdmin ? 1 : 0, userId);
      }
      this.remember(id, userId);
      return { userId, created };
    });
  }

  /** Attaches an identity to a signed-in account. */
  link(userId: number, id: Identity) {
    this.checkGroups(id);
    this.db.tx(() => {
      const owner = this.db.get("SELECT user_id FROM identities WHERE issuer=? AND sub=?", id.issuer, id.sub)?.user_id;
      if (owner !== undefined && owner !== userId) throw new OidcError("linked_elsewhere", "identity belongs to another account");
      const mine = this.db.get("SELECT sub FROM identities WHERE issuer=? AND user_id=?", id.issuer, userId)?.sub;
      if (mine !== undefined && mine !== id.sub) throw new OidcError("already_linked", "account has another identity");
      if (mine === undefined) this.db.run("INSERT INTO identities(issuer,sub,user_id,linked_at) VALUES(?,?,?,?)", id.issuer, id.sub, userId, Date.now());
      this.remember(id, userId);
    });
  }

  unlink(userId: number) {
    this.db.tx(() => {
      const b = this.unlinkBlocked(userId);
      if (b) throw new AuthError(409, "last_login_method", b);
      if (!this.db.run("DELETE FROM identities WHERE user_id=? AND issuer=?", userId, this.issuer).changes) throw new AuthError(404, "not_found", "Nothing is linked");
    });
  }
  unlinkBlocked(userId: number): string | null {
    const o = this.config.oidc;
    if (!this.db.get("SELECT pw_hash FROM users WHERE id=?", userId)?.pw_hash) return "Set a password first: otherwise you couldn't sign in any more";
    if (o && !o.passwordLogin) return "Password sign-in is switched off on this server, so you couldn't sign in any more";
    return null;
  }

  describe(p: Principal) {
    const u = this.db.get("SELECT username,pw_hash,display_name,is_admin FROM users WHERE id=?", p.userId)!;
    const i = this.db.get("SELECT username,email,linked_at,last_login_at FROM identities WHERE user_id=? AND issuer=?", p.userId, this.issuer);
    const s = p.sessionHash ? this.db.get("SELECT via FROM sessions WHERE id_hash=?", p.sessionHash) : undefined;
    return {
      username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin, hasPassword: !!u.pw_hash, passwordLogin: this.passwordLoginEnabled(), sessionVia: s?.via ?? null,
      oidc: this.config.oidc ? { providerName: this.config.oidc.providerName, issuer: this.config.oidc.issuer } : null,
      identity: i ? { username: i.username, email: i.email, linkedAt: i.linked_at, lastLoginAt: i.last_login_at, unlinkBlocked: this.unlinkBlocked(p.userId) } : null,
    };
  }
}
