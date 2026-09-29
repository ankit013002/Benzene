import { ConfiguredLinkScreen } from '../src/components/ConfiguredLinkScreen';
import { supportUrl } from '../src/config';

export default function SupportScreen() {
  return <ConfiguredLinkScreen
    title="Support"
    detail="Help for your Benzene account and Vault."
    label="Open support"
    url={supportUrl()}
    missingMessage="The service owner must configure EXPO_PUBLIC_SUPPORT_URL before a store submission."
  />;
}
