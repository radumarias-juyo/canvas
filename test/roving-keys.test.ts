import type { KeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rovingKeys } from "../src/layout.tsx";

/** A menu or tab list of `count` items, the `disabled` ones held, with whichever has focus. */
function list(role: "menu" | "tablist", count: number, disabled: number[] = []) {
  const focused: { at: number | null } = { at: null };
  const items = Array.from({ length: count }, (_, index) => ({
    index,
    disabled: disabled.includes(index),
    focus: () => {
      focused.at = index;
      vi.stubGlobal("document", { activeElement: items[index] });
    },
  }));
  const element = {
    getAttribute: (name: string) => (name === "role" ? role : null),
    querySelectorAll: (selector: string) => (selector === (role === "tablist" ? '[role="tab"]' : '[role^="menuitem"]') ? items : []),
  };
  vi.stubGlobal("document", { activeElement: null });
  const press = (key: string) => {
    let prevented = false;
    rovingKeys({ key, currentTarget: element, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent<HTMLElement>);
    return prevented;
  };
  return { focused, items, press };
}

afterEach(() => vi.unstubAllGlobals());

describe("rovingKeys", () => {
  it("moves through a menu with Up and Down, round from either end, skipping held items", () => {
    const menu = list("menu", 4, [2]);
    expect(menu.press("ArrowDown")).toBe(true);
    expect(menu.focused.at).toBe(0);
    menu.press("ArrowDown");
    expect(menu.focused.at).toBe(1);
    menu.press("ArrowDown");
    expect(menu.focused.at).toBe(3);
    menu.press("ArrowDown");
    expect(menu.focused.at).toBe(0);
    menu.press("ArrowUp");
    expect(menu.focused.at).toBe(3);
    menu.press("Home");
    expect(menu.focused.at).toBe(0);
    menu.press("End");
    expect(menu.focused.at).toBe(3);
  });

  it("starts from the last item with Up from outside the menu", () => {
    const menu = list("menu", 3);
    menu.press("ArrowUp");
    expect(menu.focused.at).toBe(2);
  });

  it("moves through tabs with Left and Right, and leaves other keys alone", () => {
    const tabs = list("tablist", 3);
    tabs.press("ArrowRight");
    tabs.press("ArrowRight");
    expect(tabs.focused.at).toBe(1);
    tabs.press("ArrowLeft");
    expect(tabs.focused.at).toBe(0);
    expect(tabs.press("ArrowDown")).toBe(false);
    expect(tabs.press("Enter")).toBe(false);
    expect(tabs.focused.at).toBe(0);
  });
});
