import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { SignJWT, exportJWK } from "jose";
import { serve } from "./helpers.ts";

/** A provider that does everything right unless told otherwise. */
export async function mockIdp() {
  const newKey = () => ({ kid: randomBytes(6).toString("hex"), ...generateKeyPairSync("rsa", { modulusLength: 2048 }) });
  const idp = {
    url: "", key: newKey(), published: [] as { kid: string; publicKey: KeyObject }[], hits: {} as Record<string, number>, codes: new Map<string, any>(), lastToken: null as any,
    user: { sub: "sub-1", preferred_username: "alice", name: "Alice A", email: "alice@example.com", groups: ["podcasts"] } as Record<string, any>,
    /** Overrides of ID token claims (undefined removes one) and behaviour switches. */
    claims: {} as Record<string, any>, sign: null as null | ((claims: any) => Promise<string>), idTokenOnly: null as null | string[], userinfoSub: null as string | null, meta: {} as Record<string, any>, basic: true, down: false,
    rotate() { idp.key = newKey(); idp.published = [idp.key]; },
    close: async () => {},
    /** What the browser does: follow the authorization URL and come back with a code. */
    authorize(location: string): { state: string; code: string; params: URLSearchParams; query: string } {
      const p = new URL(location).searchParams, code = randomBytes(12).toString("hex");
      idp.codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge"), redirect: p.get("redirect_uri") });
      const state = p.get("state")!;
      return { state, code, params: p, query: new URLSearchParams({ code, state, iss: idp.url }).toString() };
    },
    async idToken(nonce: string | null) {
      const now = Math.floor(Date.now() / 1000);
      const user = idp.idTokenOnly ? Object.fromEntries(Object.entries(idp.user).filter(([k]) => idp.idTokenOnly!.includes(k))) : idp.user;
      const c: any = { iss: idp.url, aud: "client", iat: now, exp: now + 300, nonce, ...user, ...idp.claims };
      for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
      return idp.sign ? idp.sign(c) : new SignJWT(c).setProtectedHeader({ alg: "RS256", kid: idp.key.kid }).sign(idp.key.privateKey);
    },
  };
  idp.published = [idp.key];
  const s = await serve(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    idp.hits[u.pathname] = (idp.hits[u.pathname] ?? 0) + 1;
    const json = (o: any, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (idp.down) return res.destroy();
    if (u.pathname === "/.well-known/openid-configuration") return json({
      issuer: idp.url, authorization_endpoint: `${idp.url}/authorize`, token_endpoint: `${idp.url}/token`, jwks_uri: `${idp.url}/jwks`, userinfo_endpoint: `${idp.url}/userinfo`,
      end_session_endpoint: `${idp.url}/logout`, id_token_signing_alg_values_supported: ["RS256"], authorization_response_iss_parameter_supported: true, ...idp.meta,
    });
    if (u.pathname === "/jwks") return json({ keys: await Promise.all(idp.published.map(async (k) => ({ ...(await exportJWK(k.publicKey)), kid: k.kid, alg: "RS256", use: "sig" }))) });
    if (u.pathname === "/userinfo") return req.headers.authorization === "Bearer at" ? json({ ...idp.user, sub: idp.userinfoSub ?? idp.user.sub }) : json({}, 401);
    if (u.pathname === "/token") {
      let body = "";
      for await (const c of req) body += c;
      const f = new URLSearchParams(body), c = idp.codes.get(f.get("code")!);
      idp.codes.delete(f.get("code")!);
      idp.lastToken = { form: f, auth: req.headers.authorization };
      if (req.headers.authorization !== "Basic " + Buffer.from("client:s%3Aecret").toString("base64")) return json({ error: "invalid_client" }, 401);
      if (!c || c.redirect !== f.get("redirect_uri") || createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "at", token_type: "Bearer", id_token: await idp.idToken(c.nonce) });
    }
    json({}, 404);
  });
  idp.url = s.url; idp.close = s.close as any;
  return idp;
}
export type Idp = Awaited<ReturnType<typeof mockIdp>>;
