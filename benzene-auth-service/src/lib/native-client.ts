import type { Request, Response } from "express";

export const NATIVE_CLIENT_KIND_HEADER = "X-Benzene-Client-Kind";
export const NATIVE_CLIENT_KIND = "native-mobile";

export function isNativeMobileRequest(req: Request): boolean {
  return req.get(NATIVE_CLIENT_KIND_HEADER) === NATIVE_CLIENT_KIND;
}

export function setNativeTokenResponseHeaders(res: Response): void {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}
