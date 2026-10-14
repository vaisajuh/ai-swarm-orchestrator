import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserOrigin, isPublicPath, isSameOrigin, isSignedIn, mismatchHint, normalizeToken, redirectTo, safeNext, signInLink, cleanSignInCode } from "../lib/auth.ts";
import { errorMessage, hubPath } from "../lib/hub-routes.ts";

describe("console sign-in", () => {
  const token = "aso_secret-token";
  const basic = (pw: string) => `Basic ${btoa(`any:${pw}`)}`;

  it("accepts the session cookie or Basic auth with the token", () => {
    assert.ok(isSignedIn(token, token, null));
    assert.ok(isSignedIn(token, undefined, basic(token)));
    assert.ok(!isSignedIn(token, "wrong", null));
    assert.ok(!isSignedIn(token, undefined, basic("wrong")));
    assert.ok(!isSignedIn(token, undefined, "Basic %%%not-base64"));
    assert.ok(!isSignedIn(token, undefined, `Bearer ${token}`), "the Hub's bearer form is not a browser credential");
    assert.ok(!isSignedIn(token, undefined, null));
    assert.ok(isSignedIn(undefined, undefined, null), "open when the Hub runs without a token");
  });

  it("only redirects to paths on this site after signing in", () => {
    assert.equal(safeNext("/tasks/a?x=1"), "/tasks/a?x=1");
    assert.equal(safeNext("//evil.example/x"), "/");
    assert.equal(safeNext("/\\evil.example"), "/");
    assert.equal(safeNext("https://evil.example"), "/");
    assert.equal(safeNext(undefined), "/");
  });

  it("redirects to the address the browser used, not the one the server binds to", () => {
    const phone = new Headers({ host: "192.168.101.127:7421" });
    assert.equal(browserOrigin(phone, "http://localhost:7421"), "http://192.168.101.127:7421");
    const proxied = new Headers({ host: "127.0.0.1:7421", "x-forwarded-host": "agent007.tail1234.ts.net", "x-forwarded-proto": "https" });
    assert.equal(browserOrigin(proxied, "http://localhost:7421"), "https://agent007.tail1234.ts.net");
    assert.equal(browserOrigin(new Headers(), "http://localhost:7421"), "http://localhost:7421");
    const r = redirectTo("/login?next=%2F", phone, "http://localhost:7421", 307);
    assert.equal(r.status, 307);
    assert.equal(r.headers.get("location"), "http://192.168.101.127:7421/login?next=%2F");
  });

  it("accepts POSTs only from the console's own pages", () => {
    assert.ok(isSameOrigin("http://192.168.101.127:7421", "192.168.101.127:7421"));
    assert.ok(isSameOrigin(null, "192.168.101.127:7421"), "no Origin header");
    assert.ok(!isSameOrigin("http://evil.example", "192.168.101.127:7421"));
    assert.ok(!isSameOrigin("not a url", "192.168.101.127:7421"));
  });

  it("keeps everything but sign-in and static assets behind the token", () => {
    for (const p of ["/login", "/api/session", "/manifest.webmanifest", "/icon.svg", "/_next/static/x.js"]) assert.ok(isPublicPath(p), p);
    for (const p of ["/", "/tasks/a", "/api/hub/tasks", "/loginx", "/api/sessions"]) assert.ok(!isPublicPath(p), p);
  });
});

describe("Hub proxy allowlist", () => {
  it("allows the console's reads and actions", () => {
    assert.equal(hubPath("GET", ["tasks"]), "/api/tasks");
    assert.equal(hubPath("GET", ["tasks", "api-1", "transcript"]), "/api/tasks/api-1/transcript");
    assert.equal(hubPath("POST", ["tasks", "api-1", "retry"]), "/api/tasks/api-1/retry");
    assert.equal(hubPath("POST", ["tasks", "api-1", "cancel"]), "/api/tasks/api-1/cancel");
    assert.equal(hubPath("POST", ["plans"]), "/api/plans");
    assert.equal(hubPath("POST", ["plans", "plan-1", "approve"]), "/api/plans/plan-1/approve");
    assert.equal(hubPath("GET", ["nodes"]), "/api/nodes");
    assert.equal(hubPath("GET", ["projects"]), "/api/projects");
    assert.equal(hubPath("POST", ["sign-in-codes"]), "/api/sign-in-codes");
    assert.equal(hubPath("POST", ["projects"]), "/api/projects");
    assert.equal(hubPath("GET", ["projects", "shop"]), "/api/projects/shop");
  });

  it("refuses everything else", () => {
    assert.equal(hubPath("POST", ["tasks"]), undefined, "no raw task submission from the browser");
    assert.equal(hubPath("POST", ["projects", "shop"]), undefined);
    assert.equal(hubPath("POST", ["sign-in-codes", "redeem"]), undefined, "only the console's server redeems codes");
    assert.equal(hubPath("GET", ["sign-in-codes"]), undefined);
    assert.equal(hubPath("GET", ["sync"]), undefined);
    assert.equal(hubPath("POST", ["sync"]), undefined);
    assert.equal(hubPath("GET", ["tasks", "..", "..", "git"]), undefined);
    assert.equal(hubPath("GET", ["tasks", "a", "transcript", "x"]), undefined);
    assert.equal(hubPath("DELETE", ["tasks", "a"]), undefined);
    assert.equal(hubPath("GET", ["tasks", "a/b"]), undefined);
  });
});

describe("error messages", () => {
  it("prefers the API's error text and falls back to the status", () => {
    assert.equal(errorMessage(409, { error: "task a is already merged" }), "task a is already merged");
    assert.equal(errorMessage(502, null), "HTTP 502");
    assert.equal(errorMessage(500, { error: "" }), "HTTP 500");
    assert.equal(errorMessage(500, "<html>"), "HTTP 500");
  });
});

describe("tokens typed on a phone", () => {
  const token = "aso_Xy3kQ9-abcDEF_ghij0123456789klmn";

  it("undoes what keyboards and copy-paste do, but not the random part", () => {
    assert.equal(normalizeToken(token), token);
    assert.equal(normalizeToken(`  ${token}\n`), token, "surrounding whitespace");
    assert.equal(normalizeToken(`Aso_${token.slice(4)}`), token, "auto-capitalised first letter");
    assert.equal(normalizeToken(`ASO_${token.slice(4)}`), token);
    assert.equal(normalizeToken(`${token.slice(0, 10)} ${token.slice(10)}`), token, "space from a line wrap");
    assert.equal(normalizeToken(`${token.slice(0, 10)}\u200B${token.slice(10)}`), token, "zero-width space");
    assert.equal(normalizeToken(token.replace("-", "\u2013")), token, "typographic dash");
    assert.notEqual(normalizeToken(token.replace("X", "x")), token, "case inside the random part still matters");
  });

  it("explains a failure for the log without revealing the token", () => {
    const expected = "aso_abcdefghijklmnopqrstuvwxyz012345";
    assert.equal(mismatchHint("", expected), "empty token");
    assert.equal(mismatchHint("aso_abc", expected), "7 characters (expected 36)");
    assert.equal(mismatchHint("x".repeat(36), expected), "36 characters (expected 36), does not start with aso_");
    assert.equal(mismatchHint(expected.toUpperCase().replace("ASO_", "aso_"), expected), "36 characters (expected 36), differs only in letter case");
    assert.ok(!mismatchHint("aso_zzz", expected).includes(expected.slice(4, 10)));
  });
});

describe("sign-in links", () => {
  it("point at the login page with the code, on the console's own address", () => {
    assert.equal(signInLink("https://agent007.tailc9777f.ts.net", "Ab_9-x"), "https://agent007.tailc9777f.ts.net/login?code=Ab_9-x");
    assert.equal(signInLink("http://192.168.101.127:7421/", "c"), "http://192.168.101.127:7421/login?code=c");
  });
});

describe("sign-in codes from chat apps", () => {
  it("drops punctuation that formatting glued to the link", () => {
    const code = "lTo6FMh9X5THpEeq4yBd8tH6";
    for (const raw of [code, `${code}**`, `${code}).`, ` ${code}\n`, `${code}>`, `${code}%2A%2A`]) assert.equal(cleanSignInCode(raw), code, raw);
    assert.equal(cleanSignInCode(undefined), "");
    assert.equal(cleanSignInCode("**abc"), "", "junk in front is not guessed at");
  });
});
