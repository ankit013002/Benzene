"use client";

export type LogoutResult = {
  localCookiesCleared: boolean;
  serverRevoked: boolean;
};

export async function logout(): Promise<LogoutResult> {
  try {
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });

    // The proxy clears both httpOnly cookies for every upstream response. A
    // failed status remains visible to callers so server-side revocation is
    // not mistaken for success, but the browser can still leave protected UI.
    return { localCookiesCleared: true, serverRevoked: res.ok };
  } catch {
    return { localCookiesCleared: false, serverRevoked: false };
  }
}
