import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/\u0000-\u001f\u007f]+/g, '_').replace(/^\.+$/, 'file').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'benzene-file';
}

/** Writes decrypted bytes to a temporary cache file, opens the native share/save sheet, then removes the staging copy. */
export async function sharePlaintextFile(name: string, contentType: string, plaintext: Uint8Array): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') throw new Error('Encrypted file export is available in the iOS and Android apps only.');
  if (!await Sharing.isAvailableAsync()) throw new Error('File export is available in the iOS and Android apps only.');
  const staged = new File(Paths.cache, `benzene-${Date.now()}-${safeFilename(name)}`);
  try {
    staged.write(plaintext);
    await Sharing.shareAsync(staged.uri, {
      dialogTitle: `Save or share ${safeFilename(name)}`,
      mimeType: contentType || 'application/octet-stream',
    });
  } catch {
    throw new Error('The file was decrypted but could not be exported. Try again from a connected device.');
  } finally {
    try { if (staged.exists) staged.delete(); } catch {
      // The operating system may already have removed the temporary cache entry.
    }
  }
}
