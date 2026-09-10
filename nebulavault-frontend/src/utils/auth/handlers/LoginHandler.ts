"use server";

import { cookies } from "next/headers";
import { jwtVerify, type JWTPayload } from "jose";

const RAW = (process.env.AUTH_SECRET ?? "").trim();
const secret: Uint8Array | null =
  RAW.length >= 32
    ? /^[0-9a-f]{64}$/i.test(RAW)
      ? Buffer.from(RAW, "hex")
      : Buffer.from(RAW, "utf8")
    : null;
export type Session = JWTPayload & {
  sub: string;
  email: string;
  role?: string;
  sid: string;
};

export async function verifySession(token: string): Promise<Session | null> {
  if (!secret) return null;

  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    return payload as Session;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get("session")?.value;
  if (!token) return null;
  return await verifySession(token);
}
