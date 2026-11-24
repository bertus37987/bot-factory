import { useEffect, useId, useRef, useState } from "react";
import type { AgentRecord } from "@bot-factory/shared";
import { BotAvatar, type BotRoleKind } from "./BotAvatars";

export function AgentProfile({
  name,
  role,
  job,
  status,
  model,
  seed,
}: {
  name: string;
  role: BotRoleKind;
  job: string;
  status?: AgentRecord["status"];
  model?: string;
  seed: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (e: PointerEvent | FocusEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false);
    };
    const dismissOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  return (
    <div className="agent-profile" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="agent-profile-trigger"
        aria-label={`${name} profile`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`View ${name} profile`}
        onClick={() => setOpen(!open)}
      >
        <BotAvatar role={role} size={36} live agentStatus={status} seed={seed} />
      </button>
      {open && (
        <section className="agent-profile-card" id={id} aria-label={`${name} details`}>
          <strong>{name}</strong>
          <dl>
            <dt>Role</dt><dd>{job}</dd>
            <dt>Status</dt><dd>{status?.replaceAll("_", " ") ?? "Unavailable"}</dd>
            {model && <><dt>Model</dt><dd>{model}</dd></>}
          </dl>
        </section>
      )}
    </div>
  );
}
