/** Where a UserDirectory keeps its user's uid, for a wake that does not say it. */
const UID_KEY = "uid";

/**
 * The uid a UserDirectory is for: its name, kept as it comes, or for an object woken without its name (by its alarm,
 * for a dream or a sign-in's keep-alive) the name it kept the last time it had it. Undefined only for an object that never
 * had its name. The uid opens the user's sign-ins and finds their chats: never guessed.
 */
export function directoryUid(name: string | undefined, kv: { get<T>(key: string): T | undefined; put(key: string, value: unknown): void }): string | undefined {
  if (name) {
    if (kv.get<string>(UID_KEY) !== name) kv.put(UID_KEY, name);
    return name;
  }
  return kv.get<string>(UID_KEY);
}
