import { NextResponse, type NextRequest } from "next/server";
import {
  browserOrigin,
  cleanSignInCode,
  constantTimeEqual,
  mismatchHint,
  normalizeToken,
  redirectTo,
  safeNext,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
} from "../../../lib/auth.ts";
import { redeemSignInCode } from "../../../lib/hub-server.ts";

/** Sign in with the ASO token or a one-time sign-in link's code (form post from /login). */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = normalizeToken(String(form.get("token") ?? ""));
  const code = cleanSignInCode(String(form.get("code") ?? ""));
  const next = safeNext(String(form.get("next") ?? "/"));
  const expected = process.env.ASO_TOKEN;
  if (expected && code) {
    if (!(await redeemSignInCode(code))) {
      console.warn(`[console] sign-in link refused from ${request.headers.get("x-forwarded-for") ?? "unknown address"}: used up or expired`);
      return redirectTo(`/login?next=${encodeURIComponent(next)}&error=link`, request.headers, request.nextUrl.origin);
    }
  } else if (expected && !constantTimeEqual(token, expected)) {
    const from = request.headers.get("x-forwarded-for") ?? "unknown address";
    console.warn(`[console] sign-in failed from ${from}: ${mismatchHint(token, expected)}`);
    return redirectTo(`/login?next=${encodeURIComponent(next)}&error=1`, request.headers, request.nextUrl.origin);
  }
  const response = new NextResponse(null, { status: 303, headers: { location: new URL(next, browserOrigin(request.headers, request.nextUrl.origin)).href } });
  if (expected) {
    console.info(`[console] signed in from ${request.headers.get("x-forwarded-for") ?? "unknown address"}`);
    response.cookies.set(SESSION_COOKIE, expected, {
      httpOnly: true,
      sameSite: "lax",
      // Behind an HTTPS proxy (e.g. Tailscale) the server itself only sees http.
      secure: request.headers.get("x-forwarded-proto") === "https" || request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: SESSION_MAX_AGE_SEC,
    });
  }
  return response;
}

/** Sign out. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
