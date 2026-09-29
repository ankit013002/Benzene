import { ConfiguredLinkScreen } from '../src/components/ConfiguredLinkScreen';
import { termsOfServiceUrl } from '../src/config';

export default function TermsScreen() {
  return <ConfiguredLinkScreen
    title="Terms"
    detail="Terms for using this Benzene service."
    label="Open terms of service"
    url={termsOfServiceUrl()}
    missingMessage="The service owner must publish terms and set EXPO_PUBLIC_TERMS_OF_SERVICE_URL before a store submission. This screen does not invent or replace those terms."
  />;
}
