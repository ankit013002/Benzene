import { NextRequest } from "next/server";

import { proxyToGateway } from "@/utils/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, context: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await context.params;
  return proxyToGateway(`/files/${encodeURIComponent(nodeId)}/encrypted-object`);
}
