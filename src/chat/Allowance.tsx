import { memo, useCallback, useEffect, useState } from "react";
import { allowanceLevel, limitNote, resetsAt, type Allowance } from "../../shared/allowance.ts";
import { api } from "../api.ts";
import { useDismiss } from "../layout.tsx";
import { useVisible } from "../sidebar.ts";
import { COUNT, formatCost } from "./spend.ts";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** How long after a reply ends the ring reads again: the chat counts what it cost every couple of seconds, not at once. */
const AFTER_REPLY_MS = 3_000;

/**
 * The daily allowance ring, beside the context ring: what the viewer's model calls cost today (real cost, as each
 * answer reported it) against their daily limit, which pauses their scheduled runs and agents' unprompted posts once
 * reached; their own messages go on. Read when it shows, when the page comes back into view, and a little after
 * `working` ends. A click opens the numbers. Nothing until the first read, nor when the read fails.
 */
export const AllowanceRing = memo(function AllowanceRing({ working }: { working: boolean }) {
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, setOpen);
  const visible = useVisible();
  const read = useCallback(() => {
    api.allowance().then(setAllowance, () => {});
  }, []);
  useEffect(() => {
    if (visible) read();
  }, [visible, read]);
  useEffect(() => {
    if (working || !visible) return;
    const timer = setTimeout(read, AFTER_REPLY_MS);
    return () => clearTimeout(timer);
  }, [working, visible, read]);
  useEffect(() => {
    if (open) read();
  }, [open, read]);
  if (!allowance) return null;
  const { share, percent, level } = allowanceLevel(allowance.spent, allowance.limit);
  const limited = allowance.limit > 0;
  const label = limited ? `Today's allowance: ${formatCost(allowance.spent)} of ${formatCost(allowance.limit)} (${percent}%)` : `Today: ${formatCost(allowance.spent)}`;
  const resets = new Date(resetsAt(Date.now())).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className={`context-meter allowance-meter ${level}`} ref={box}>
      <button type="button" className="icon-button context-ring" onClick={() => setOpen(!open)} aria-expanded={open} title={label} aria-label={label}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="track" cx="9" cy="9" r={RADIUS} />
          <circle className="fill" cx="9" cy="9" r={RADIUS} strokeDasharray={`${share * CIRCUMFERENCE} ${CIRCUMFERENCE}`} transform="rotate(-90 9 9)" />
          {/* A coin's mark, so it does not read as a second context ring. */}
          <path className="mark" d="M9 6v6M7.3 7.6h2.6a.9.9 0 0 1 0 1.8H8.1a.9.9 0 0 0 0 1.8h2.6" />
        </svg>
      </button>
      {open && (
        <div className="context-panel" role="dialog" aria-label="Today's allowance">
          <div className="context-head">
            <strong>Today's allowance</strong>
            {limited && <span>{percent}%</span>}
          </div>
          {limited && (
            <div className="context-bar" aria-hidden="true">
              <span style={{ width: `${share * 100}%` }} />
            </div>
          )}
          <span>
            {limited ? `${formatCost(allowance.spent)} of ${formatCost(allowance.limit)}` : formatCost(allowance.spent)} · {COUNT.format(allowance.tokens)} tokens
          </span>
          <small>
            What your model calls cost today, as each answer reported it: in your chats, your agents' turns and their runs.{" "}
            {limitNote(allowance.spent, allowance.limit, resets)}
          </small>
          {allowance.pages.limit > 0 && allowance.pages.spent > 0 && (
            <small>
              Pages' model calls you typed into: {formatCost(allowance.pages.spent)} of {formatCost(allowance.pages.limit)} today, counted apart.
            </small>
          )}
        </div>
      )}
    </div>
  );
});
