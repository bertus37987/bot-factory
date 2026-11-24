import { Paperclip } from "lucide-react";
import { createContext } from "react";
import type { AttachmentDestination } from "./types";

export const AttachmentDestinations = createContext<AttachmentDestination[] | null>(null);

export function AttachmentActions({
  destinations,
  disabled,
  onAdd,
}: {
  destinations: AttachmentDestination[] | null;
  disabled?: boolean;
  onAdd: (destinationKey?: string) => void;
}) {
  if (destinations?.length === 0) return <span className="attachment-unavailable">Open a conversation to add this.</span>;
  return (
    <fieldset className="attachment-actions" aria-label="Add to draft">
      {(destinations ?? [{ key: undefined, label: "Chat" }]).map(({ key, label }) => (
        <button
          key={key ?? "chat"}
          type="button"
          className="btn xs attachment-action"
          disabled={disabled}
          onClick={() => onAdd(key)}
          title={`Add to ${label} draft without sending`}
        >
          <Paperclip size={13} />
          <span>Add to {label}</span>
        </button>
      ))}
    </fieldset>
  );
}
