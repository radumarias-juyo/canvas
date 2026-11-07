import { fromBase64, toBase64 } from "../../shared/util.ts";
import type { McpAuthRecord } from "./oauth.ts";

/**
 * A user's MCP sign-in records at rest. The refresh token in one is the real credential (the app is a public OAuth
 * client, with no secret of its own), so each record is encrypted with AES-GCM under the user's own key
 * (`mcpTokensKey` in worker/storage/), with the server's name as additional data: a copy of the storage alone reads
 * nothing, and a record moved to another server's row does not open.
 *
 * Stored as `v1.<base64 of iv | ciphertext>`. A record written before encryption is plain JSON and still opens
 * (`plain` says so, so the caller writes it again sealed).
 */
const PREFIX = "v1.";
const IV_BYTES = 12;

export async function sealAuthRecord(key: CryptoKey, server: string, record: McpAuthRecord): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(JSON.stringify(record));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(server) }, key, data));
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return PREFIX + toBase64(out);
}

export async function openAuthRecord(key: CryptoKey, server: string, stored: string): Promise<{ record: McpAuthRecord; plain: boolean }> {
  if (!stored.startsWith(PREFIX)) return { record: JSON.parse(stored) as McpAuthRecord, plain: true };
  const bytes = fromBase64(stored.slice(PREFIX.length));
  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: aad(server) },
    key,
    bytes.subarray(IV_BYTES),
  );
  return { record: JSON.parse(new TextDecoder().decode(data)) as McpAuthRecord, plain: false };
}

const aad = (server: string) => new TextEncoder().encode(`pi-artifacts/mcp-auth/${server}`);
