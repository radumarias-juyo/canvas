/** Delete every object under `prefix` (but those under `keep`), a page of the listing at a time. */
export async function deletePrefix(bucket: R2Bucket, prefix: string, keep?: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    const keys: string[] = page.objects.map((object: R2Object) => object.key).filter((key: string) => !keep || !key.startsWith(keep));
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Every object under `prefix`, however many pages the listing takes. */
export async function listPrefix(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/** Delete the objects at `keys`, however many: R2 deletes at most 1,000 a call. */
export async function deleteKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}
