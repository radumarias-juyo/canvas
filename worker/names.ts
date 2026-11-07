// The names of Durable Objects that other objects address, in a module with no imports, so any of them can use it.

/** The name of a user's chat object. The uid must come from a verified identity: it is what keeps users apart. */
export function chatAgentName(uid: string, chatId: string): string {
  return `${uid}:${chatId}`;
}

/** The uid and chat id a chat object's name was built from (see chatAgentName). */
export function parseChatAgentName(name: string): { uid: string; chatId: string } {
  const [uid, chatId] = name.split(":");
  return { uid, chatId };
}
