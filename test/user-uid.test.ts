import { describe, expect, it } from "vitest";
import { directoryUid } from "../worker/user-uid.ts";
import { memoryKv } from "./fakes.ts";

describe("the uid a user's directory is for", () => {
  it("is its name, kept, and the kept one when its alarm wakes it without its name (a dream, a keep-alive)", () => {
    const kv = memoryKv();
    expect(directoryUid("ada", kv)).toBe("ada");
    // Woken by its alarm, nameless: the dream reads ada's chats and the sign-ins open with ada's key.
    expect(directoryUid(undefined, kv)).toBe("ada");
    expect(kv.map.get("uid")).toBe("ada");
  });

  it("is unknown for an object that never had its name, never another's", () => {
    expect(directoryUid(undefined, memoryKv())).toBeUndefined();
    const kv = memoryKv();
    directoryUid("ada", kv);
    // A name always wins over what was kept.
    expect(directoryUid("bob", kv)).toBe("bob");
    expect(directoryUid(undefined, kv)).toBe("bob");
  });
});
