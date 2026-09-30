import { appleAppSiteAssociation, associationResponse } from '../_association';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const association = appleAppSiteAssociation();
  return association
    ? associationResponse(association)
    : associationResponse({ error: 'App link association is not configured.' }, 404);
}
