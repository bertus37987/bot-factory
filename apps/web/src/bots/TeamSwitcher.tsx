import { ChevronDown, Users } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentRecord, ProjectRecord } from "@bot-factory/shared";
import { BotAvatar, GroupAvatarCluster, type BotRoleKind, resolveBotRole } from "../components/BotAvatars";

type TeamSwitcherProps = {
  projects: ProjectRecord[];
  agents: AgentRecord[];
  project: ProjectRecord | null;
  onSelect: (id: string) => void;
};

function TeamPortrait({ roles, size }: { roles: BotRoleKind[]; size: number }) {
  const [first] = roles;
  if (!first) return <Users size={16} />;
  if (roles.length === 1) return <BotAvatar role={first} size={size} />;
  return <GroupAvatarCluster roles={roles} size={size} />;
}

export function TeamSwitcher({ projects, agents, project, onSelect }: TeamSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const teams = projects.filter((p) => p.status !== "archived");
  const results = teams.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const current = results[Math.min(cursor, results.length - 1)];
  const roster = (id?: string) => agents.filter((a) => a.projectId === id && a.scope !== "sidekick");
  const roles = (id?: string) => roster(id).slice(0, 3).map((a) => resolveBotRole(a).role);
  const triggerRoles = roles(project?.id);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !current) return;
    document.getElementById(`${listId}-${current.id}`)?.scrollIntoView({ block: "nearest" });
  }, [open, current, listId]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const select = (id: string) => {
    onSelect(id);
    close();
  };

  return (
    <div className="bots-team-switcher" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="bots-team-trigger"
        aria-label={`Switch team: ${project?.name ?? "No team"}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={!teams.length}
        onClick={() => {
          setQuery("");
          setCursor(Math.max(0, teams.findIndex((p) => p.id === project?.id)));
          setOpen(!open);
        }}
      >
        <TeamPortrait roles={triggerRoles} size={26} />
        <span className="bots-team-trigger-copy">
          <span>Team</span>
          <strong>{project?.name ?? "No team yet"}</strong>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="bots-team-pop">
          <input
            ref={search}
            role="combobox"
            aria-label="Find a team"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
            placeholder="Find a team..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.stopPropagation(); close(); }
              if (e.key === "Enter" && current) { e.preventDefault(); select(current.id); }
              if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length) {
                e.preventDefault();
                const index = results.findIndex((p) => p.id === current?.id);
                setCursor((index + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
              }
            }}
          />
          <div id={listId} role="listbox" aria-label="Teams">
            {results.map((team) => {
              const members = roster(team.id);
              const working = members.filter((a) => a.status === "working" || a.status === "debating").length;
              const teamRoles = roles(team.id);
              return (
                <div
                  key={team.id}
                  id={`${listId}-${team.id}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={team.id === current?.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(team.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      select(team.id);
                    }
                  }}
                >
                  <TeamPortrait roles={teamRoles} size={28} />
                  <span className="bots-team-option-copy"><strong>{team.name}</strong><small>
                    {members.length} {members.length === 1 ? "bot" : "bots"}
                    {team.status === "paused" ? " / Paused" : working > 0 ? ` / ${working} working` : ""}
                    {team.id === project?.id ? " / Current" : ""}
                  </small></span>
                </div>
              );
            })}
          </div>
          {!results.length && <p role="status">No matching teams.</p>}
        </div>
      )}
    </div>
  );
}
