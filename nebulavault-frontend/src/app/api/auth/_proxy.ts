import { NextRequest, NextResponse } from "next/server";

import { gatewayOrigin } from "@/utils/gateway";

function splitSetCookieHeader(header: string): string[] {
  // Fetch implementations without getSetCookie expose a comma-joined value.
  // Expires dates also contain commas, so split only where the next token is
  // shaped like the start of another cookie.
  return header.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
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

  const upstream = await fetch(`${gatewayOrigin()}${path}`, {
    method: "POST",
    headers,
    body:
      path === "/auth/logout" || path === "/auth/refresh"
        ? undefined
        : await request.text(),
    cache: "no-store",
    redirect: "manual",
  });

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

  // Logout should remove both browser credentials even if an intermediary
  // drops one of the upstream clearing headers.
  if (path === "/auth/logout" && upstream.ok) {
    for (const name of ["session", "refresh_token"]) {
      if (!forwardedCookieNames.has(name)) {
        responseHeaders.append(
          "set-cookie",
          `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
            process.env.NODE_ENV === "production" ? "; Secure" : ""
          }`,
        );
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
