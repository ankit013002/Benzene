import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { jwtVerify } from "jose";

const RAW = (process.env.AUTH_SECRET ?? "").trim();
const secret = /^[0-9a-f]{64}$/i.test(RAW)
  ? Uint8Array.from(RAW.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
  : new TextEncoder().encode(RAW);

const isPublic = (p: string) =>
  p === "/" ||
  p === "/login" ||
  p === "/register" ||
  p === "/favicon.ico" ||
  p.startsWith("/auth") ||
  p.startsWith("/api/auth") ||
  p.startsWith("/_next") ||
  p.startsWith("/static") ||
  p.startsWith("/api/public");

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  if (getSetCookie) {
    const cookies = getSetCookie.call(headers);
    if (cookies.length > 0) return cookies;
  }

  const combined = headers.get("set-cookie") ?? "";
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).filter(Boolean);
}

function cookieNameValue(setCookie: string): [string, string] | null {
  const match = setCookie.match(/^\s*([^=;\s]+)=([^;]*)/);
  return match ? [match[1], match[2]] : null;
}

function clearAuthCookies(response: NextResponse): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  for (const name of ["session", "refresh_token"]) {
    response.headers.append(
      "set-cookie",
      `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
    );
  }
}

async function refreshSession(req: NextRequest): Promise<NextResponse | null> {
  const origin = (process.env.GATEWAY_ORIGIN ?? process.env.NEXT_PUBLIC_GATEWAY_ORIGIN)
    ?.trim()
    .replace(/\/+$/, "");
  const cookie = req.headers.get("cookie");
  if (!origin || !cookie) return null;

  try {
    const upstream = await fetch(`${origin}/auth/refresh`, {
      method: "POST",
      headers: { cookie },
      cache: "no-store",
      redirect: "manual",
    });
    if (!upstream.ok) return null;

    const setCookies = setCookieHeaders(upstream.headers);
    const rotated = new Map<string, string>();
    for (const setCookie of setCookies) {
      const pair = cookieNameValue(setCookie);
      if (pair) rotated.set(pair[0], pair[1]);
    }
    // A successful refresh must rotate both credentials. Treat a malformed
    // upstream response as failure instead of allowing the old request on.
    const refreshedSession = rotated.get("session");
    if (!refreshedSession || !rotated.get("refresh_token")) return null;
    try {
      // The gateway is authoritative for refresh-token validity, while this
      // local check ensures the request that continues through Next can also
      // be consumed by server components using the same signing key.
      await jwtVerify(refreshedSession, secret, { algorithms: ["HS256"] });
    } catch {
      return null;
    }

    const requestHeaders = new Headers(req.headers);
    const requestCookies = new Map<string, string>();
    for (const part of cookie.split(";")) {
      const pair = cookieNameValue(part);
      if (pair) requestCookies.set(pair[0], pair[1]);
    }
    for (const [name, value] of rotated) requestCookies.set(name, value);
    requestHeaders.set(
      "cookie",
      [...requestCookies].map(([name, value]) => `${name}=${value}`).join("; "),
    );

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    for (const setCookie of setCookies) {
      response.headers.append("set-cookie", setCookie);
    }
    return response;
  } catch {
    return null;
  }
}

function loginRedirect(req: NextRequest, clearCookies: boolean): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/login?next=${encodeURIComponent(req.nextUrl.pathname)}`, req.url),
  );
  if (clearCookies) clearAuthCookies(response);
  return response;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) {
    if (pathname === "/") {
      const token = req.cookies.get("session")?.value;
      if (token) {
        try {
          await jwtVerify(token, secret, { algorithms: ["HS256"] });
          return NextResponse.redirect(new URL("/dashboard", req.url));
        } catch {}
      }
    }
    return NextResponse.next();
  }

  const token = req.cookies.get("session")?.value;
  const refreshToken = req.cookies.get("refresh_token")?.value;

  if (token) {
    try {
      await jwtVerify(token, secret, { algorithms: ["HS256"] });
      return NextResponse.next();
    } catch {
      // An expired access token is recoverable when the refresh cookie remains
      // valid. The refresh request below is server-to-server and never exposes
      // either token to browser JavaScript or application logs.
    }
  }

  if (refreshToken) {
    const refreshed = await refreshSession(req);
    if (refreshed) return refreshed;
    return loginRedirect(req, true);
  }

  return loginRedirect(req, false);
}

export const config = { matcher: ["/:path*"] };
