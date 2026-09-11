import { NextRequest, NextResponse } from "next/server";

import { gatewayOrigin } from "@/utils/gateway";

const AUTH_COOKIE_NAMES = ["session", "refresh_token"] as const;

function splitSetCookieHeader(header: string): string[] {
  if (!header.trim()) return [];

  // Fetch implementations without getSetCookie expose a comma-joined value.
  // Expires dates also contain commas, so split only where the next token is
  // shaped like the start of another cookie.
  return header.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

function appendClearingCookies(headers: Headers, names: readonly string[]): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  for (const name of names) {
    headers.append(
      "set-cookie",
      `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
    );
  }
}

/**
 * Keep authentication cookies on the browser's origin. The gateway is an
 * upstream service, so its Set-Cookie headers must be copied explicitly.
 */
export async function proxyAuthRequest(
  path: "/auth/login" | "/auth/signup" | "/auth/logout" | "/auth/refresh",
  request: NextRequest,
): Promise<NextResponse> {
  const headers = new Headers({
    "content-type": request.headers.get("content-type") ?? "application/json",
  });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayOrigin()}${path}`, {
      method: "POST",
      headers,
      body:
        path === "/auth/logout" || path === "/auth/refresh"
          ? undefined
          : await request.text(),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    if (path !== "/auth/logout") throw error;

    // A requested logout must still remove browser credentials if the gateway
    // is unavailable. Keep the failure visible to the caller as a 502.
    const responseHeaders = new Headers({ "content-type": "application/json" });
    appendClearingCookies(responseHeaders, AUTH_COOKIE_NAMES);
    return new NextResponse(JSON.stringify({ error: "Auth service unavailable" }), {
      status: 502,
      headers: responseHeaders,
    });
  }

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);

  const getSetCookie = (
    upstream.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const setCookies = getSetCookie
    ? getSetCookie.call(upstream.headers)
    : splitSetCookieHeader(upstream.headers.get("set-cookie") ?? "");
  const forwardedCookieNames = new Set(
    setCookies
      .map((setCookie) => setCookie.match(/^\s*([^=;\s]+)=/)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  for (const setCookie of setCookies) {
    responseHeaders.append("set-cookie", setCookie);
  }

  // Logout should remove both browser credentials even if the auth service or
  // an intermediary fails before it can emit its own clearing headers.
  if (path === "/auth/logout") {
    for (const name of AUTH_COOKIE_NAMES) {
      if (!forwardedCookieNames.has(name)) {
        appendClearingCookies(responseHeaders, [name]);
      }
    }
  }

  // Refresh rotates httpOnly cookies only. Do not copy an upstream response
  // body here, even if the auth service regresses to returning a token JSON
  // payload; access tokens must never be exposed to browser JavaScript.
  const responseBody = path === "/auth/refresh" ? null : await upstream.text();

  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
