import { memo, useCallback, useId, useState } from "react";
import { MAKE_CHOICES, type MakeKind } from "../../shared/make.ts";
import { Icon } from "../Icon.tsx";
import { useDismiss } from "../layout.tsx";

/** What each choice makes, drawn small: a speech bubble, a page, a helper, a wrench; Auto a spark. */
const GLYPHS: Record<MakeKind, string> = {
  auto: "M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2",
  answer: "M5 5h14v10H9l-4 4z",
  page: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  agent: "M4 5h16v14H4zM9 11v1M15 11v1M12 2v3",
  tool: "M14.5 6.5a4 4 0 0 0 5 5l-8 8a2 2 0 0 1-3-3l8-8a4 4 0 0 0-2-2z",
};

/**
 * The composer's "Make" choice: what the next message should come to, an answer in the chat, a page, an agent that runs
 * on its own, or a tool (a skill), or Auto, which reads the message for a schedule or a watch (shared/make.ts). Shows
 * the choice on its button; a choice other than Auto is marked, and the composer sets it back to Auto once it is sent.
 */
export const MakePicker = memo(function MakePicker({ value, onChange, compact }: { value: MakeKind; onChange: (kind: MakeKind) => void; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const box = useDismiss<HTMLDivElement>(open, close);
  const menu = useId();
  const current = MAKE_CHOICES.find((choice) => choice.kind === value) ?? MAKE_CHOICES[0];
  return (
    <div className="composer-more composer-make" ref={box}>
      <button
        type="button"
        className={`make-button${value === "auto" ? "" : " chosen"}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={open ? menu : undefined}
        aria-label={`Make: ${current.label}`}
        title={`Make: ${current.label}. ${current.hint}`}
      >
        <Icon size={14} stroke={2}>
          <path d={GLYPHS[value]} />
        </Icon>
        {/* On a phone only the glyph, unless something other than Auto is chosen. */}
        {(!compact || value !== "auto") && <span>{current.label}</span>}
      </button>
      {open && (
        <div className="composer-more-menu make-menu" id={menu} role="menu" aria-label="What to make">
          {MAKE_CHOICES.map((choice) => (
            <button
              key={choice.kind}
              type="button"
              role="menuitemradio"
              aria-checked={choice.kind === value}
              onClick={() => {
                close();
                onChange(choice.kind);
              }}
            >
              <span className="composer-more-glyph" aria-hidden="true">
                <Icon size={16} stroke={2}>
                  <path d={GLYPHS[choice.kind]} />
                </Icon>
              </span>
              <span className="make-choice">
                <span>{choice.label}</span>
                <small>{choice.hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
