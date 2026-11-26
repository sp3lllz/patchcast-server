import type { Config } from "./config.ts";
import type { Db, Row } from "./db.ts";
import type { Principal } from "./auth.ts";
import { OidcError, deriveUsername, type Identity } from "./oidc.ts";

/**
 * Which local account a verified identity belongs to. Identity is (issuer, sub), never a name or an email address.
 * Accounts are only ever created here; there are no passwords.
 */
export class Accounts {
  private db: Db;
  private config: Config;
  constructor(db: Db, config: Config) { this.db = db; this.config = config; }

  private get oidc() { return this.config.oidc; }
  private adminCount() { return (this.db.get("SELECT COUNT(*) n FROM users WHERE is_admin=1") as Row).n as number; }

  private checkGroups(id: Identity) {
    const allowed = this.oidc.allowedGroups;
    if (allowed.length && !allowed.some((g) => id.groups.includes(g))) throw new OidcError("not_allowed", "not in an allowed group");
  }
  /** true/false from OIDC_ADMIN_GROUPS, or null when that isn't set (admin rights are then managed only here). */
  private wantsAdmin(id: Identity): boolean | null {
    const groups = this.oidc.adminGroups;
    return groups.length ? groups.some((g) => id.groups.includes(g)) : null;
  }
  private remember(id: Identity, userId: number) {
    const now = Date.now();
    this.db.run("UPDATE identities SET username=?, email=?, last_login_at=? WHERE issuer=? AND sub=?", id.preferredUsername, id.email, now, id.issuer, id.sub);
    if (id.name) this.db.run("UPDATE users SET display_name=? WHERE id=?", id.name, userId);
  }

  /**
   * Finds or creates the account for an identity, strictly by (issuer, sub).
   *
   * First administrator: while the server has no accounts at all, the first sign-in that creates one becomes the
   * administrator. With OIDC_ADMIN_GROUPS set it must be in one of those groups (anybody else is turned away until an
   * administrator exists); without it, the very first person the provider lets through becomes administrator.
   * Runs in one IMMEDIATE transaction, so two simultaneous first sign-ins can't both become the first.
   */
  signIn(id: Identity): { userId: number; created: boolean; isAdmin: boolean } {
    this.checkGroups(id);
    return this.db.tx(() => {
      const wantsAdmin = this.wantsAdmin(id);
      let userId = this.db.get("SELECT user_id FROM identities WHERE issuer=? AND sub=?", id.issuer, id.sub)?.user_id as number | undefined;
      const created = userId === undefined;
      let isAdmin: boolean;
      if (userId === undefined) {
        const first = !this.db.get("SELECT 1 FROM users");
        if (!this.oidc.autoCreate) throw new OidcError("no_account", first ? "no accounts yet and OIDC_AUTO_CREATE=false" : "no linked account");
        if (first && wantsAdmin === false) throw new OidcError("setup_first", "first sign-in is not in OIDC_ADMIN_GROUPS");
        isAdmin = first || wantsAdmin === true;
        const username = deriveUsername(id, (u) => !!this.db.get("SELECT 1 FROM users WHERE username=?", u));
        // pw_hash is NOT NULL in the schema; '' means "no password" and is never read.
        userId = Number(this.db.run("INSERT INTO users(username,pw_hash,is_admin,created_at) VALUES(?,'',?,?)", username, isAdmin ? 1 : 0, Date.now()).lastInsertRowid);
        this.db.run("INSERT INTO identities(issuer,sub,user_id,linked_at) VALUES(?,?,?,?)", id.issuer, id.sub, userId, Date.now());
      } else {
        isAdmin = !!this.db.get("SELECT is_admin FROM users WHERE id=?", userId)!.is_admin;
        // Group membership is re-applied at every sign-in. The last administrator is never demoted.
        if (wantsAdmin !== null && wantsAdmin !== isAdmin && (wantsAdmin || this.adminCount() > 1)) {
          this.db.run("UPDATE users SET is_admin=? WHERE id=?", wantsAdmin ? 1 : 0, userId);
          isAdmin = wantsAdmin;
        }
      }
      this.remember(id, userId);
      return { userId, created, isAdmin };
    });
  }

  describe(p: Principal) {
    const u = this.db.get("SELECT username,display_name,is_admin FROM users WHERE id=?", p.userId)!;
    const i = this.db.get("SELECT username,email,linked_at,last_login_at FROM identities WHERE user_id=? AND issuer=?", p.userId, this.oidc.issuer);
    const s = p.sessionHash ? this.db.get("SELECT via FROM sessions WHERE id_hash=?", p.sessionHash) : undefined;
    return {
      username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin, sessionVia: s?.via ?? null,
      oidc: { providerName: this.oidc.providerName, issuer: this.oidc.issuer },
      identity: i ? { username: i.username, email: i.email, linkedAt: i.linked_at, lastLoginAt: i.last_login_at } : null,
    };
  }
}
