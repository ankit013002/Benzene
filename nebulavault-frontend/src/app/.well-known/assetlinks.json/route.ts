import { androidAssetLinks, associationResponse } from '../_association';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const association = androidAssetLinks();
  return association
    ? associationResponse(association)
    : associationResponse({ error: 'App link association is not configured.' }, 404);
}
