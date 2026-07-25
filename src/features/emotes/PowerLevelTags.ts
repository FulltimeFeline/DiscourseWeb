// Cinny-compatible power-level tags/badges.
//
// Reads the `in.cinny.room.power_level_tags` state event (a flat map
// powerLevel to { name, color?, icon?: { key } }). `icon.key` is either a
// unicode emoji or an `mxc://` custom-emote url. `displayTag(level)` returns the
// exact tag, else the nearest defined tag at or below the level (so a creator
// with "infinite" power inherits the top role), else a coarse built-in default.
//
// Reads and writes use the raw client-server state API (no FFI reader for
// arbitrary state in this SDK build), via session.restGet or a raw PUT.

import type { MatrixSession } from "@/core/MatrixSession";
import { Store } from "@/core/reactive";

const TAGS_EVENT = "in.cinny.room.power_level_tags";

export interface PowerLevelTag {
  level: number;
  name: string;
  color?: string;
  /** unicode emoji OR mxc:// url. */
  icon?: string;
  iconIsMxc: boolean;
}

/** For SenderProfile.roleTag consumption. */
export interface RoleTag {
  label: string;
  /** unicode emoji or mxc:// url. */
  icon?: string;
  color?: string;
}

const BUILT_IN_DEFAULTS: PowerLevelTag[] = [
  { level: -1, name: "Muted", iconIsMxc: false },
  { level: 0, name: "Member", iconIsMxc: false },
  { level: 50, name: "Moderator", iconIsMxc: false },
  { level: 100, name: "Admin", iconIsMxc: false },
];

/** Parse the raw content of `in.cinny.room.power_level_tags`. */
export function parsePowerLevelTags(content: any): PowerLevelTag[] {
  if (!content || typeof content !== "object") return [];
  const tags: PowerLevelTag[] = [];
  for (const [levelStr, raw] of Object.entries<any>(content)) {
    const level = Number(levelStr);
    if (!Number.isFinite(level) || !raw || typeof raw !== "object") continue;
    const name = typeof raw.name === "string" ? raw.name : undefined;
    if (!name) continue;
    const iconKey = typeof raw.icon?.key === "string" ? raw.icon.key : undefined;
    tags.push({
      level,
      name,
      color: typeof raw.color === "string" ? raw.color : undefined,
      icon: iconKey,
      iconIsMxc: !!iconKey && iconKey.startsWith("mxc://"),
    });
  }
  return tags.sort((a, b) => a.level - b.level);
}

/**
 * Resolve the display tag for a power level: exact match, else nearest defined
 * tag at or below the level, else a coarse built-in default.
 */
export function displayTag(tags: PowerLevelTag[], level: number): RoleTag {
  const source = tags.length > 0 ? tags : BUILT_IN_DEFAULTS;
  // Exact.
  const exact = source.find((t) => t.level === level);
  if (exact) return toRole(exact);
  // Nearest at or below.
  let best: PowerLevelTag | undefined;
  for (const t of source) {
    if (t.level <= level && (!best || t.level > best.level)) best = t;
  }
  if (best) return toRole(best);
  // Below all tags → coarse built-in.
  const fallback = nearestBuiltIn(level);
  return toRole(fallback);
}

function nearestBuiltIn(level: number): PowerLevelTag {
  let best = BUILT_IN_DEFAULTS[0];
  for (const t of BUILT_IN_DEFAULTS) {
    if (t.level <= level) best = t;
  }
  return best;
}

function toRole(t: PowerLevelTag): RoleTag {
  return { label: t.name, icon: t.icon, color: t.color };
}

/** A cache of parsed tags per room. */
export class PowerLevelTagStore {
  private cache = new Map<string, { tags: PowerLevelTag[]; fetchedAt: number }>();
  private inflight = new Map<string, Promise<PowerLevelTag[]>>();
  private static TTL = 10 * 60 * 1000;

  /** Bumped whenever a room's tags load or change, so consumers re-render. */
  readonly version = new Store(0);
  private bump() {
    this.version.update((n) => n + 1);
  }

  constructor(private session: MatrixSession) {}

  /** Cached tags for a room if loaded, else empty (built-ins used for lookup). */
  tagsFor(roomId: string): PowerLevelTag[] {
    return this.cache.get(roomId)?.tags ?? [];
  }

  /** Resolve a role tag for a level, loading state lazily. */
  async roleFor(roomId: string, level: number): Promise<RoleTag> {
    await this.ensure(roomId);
    return displayTag(this.tagsFor(roomId), level);
  }

  /** Synchronous role lookup against whatever is cached (built-ins if empty). */
  roleForSync(roomId: string, level: number): RoleTag {
    return displayTag(this.tagsFor(roomId), level);
  }

  async ensure(roomId: string): Promise<PowerLevelTag[]> {
    const hit = this.cache.get(roomId);
    if (hit && Date.now() - hit.fetchedAt < PowerLevelTagStore.TTL) return hit.tags;
    const inflight = this.inflight.get(roomId);
    if (inflight) return inflight;
    const task = (async () => {
      const content = await this.session.restGet(
        `_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${TAGS_EVENT}/`,
      );
      const tags = parsePowerLevelTags(content);
      this.cache.set(roomId, { tags, fetchedAt: Date.now() });
      this.inflight.delete(roomId);
      this.bump();
      return tags;
    })();
    this.inflight.set(roomId, task);
    return task;
  }

  /**
   * Write the whole tag map, dropping tags equal to the built-in default
   * (name-only match at the built-in level). Requires state-event permission.
   */
  async save(
    roomId: string,
    tags: PowerLevelTag[],
  ): Promise<{ ok: boolean; forbidden?: boolean }> {
    const content: Record<string, any> = {};
    for (const t of tags) {
      const builtIn = BUILT_IN_DEFAULTS.find((d) => d.level === t.level);
      if (builtIn && builtIn.name === t.name && !t.icon && !t.color) continue; // drop default-equal
      content[String(t.level)] = {
        name: t.name,
        ...(t.color ? { color: t.color } : {}),
        ...(t.icon ? { icon: { key: t.icon } } : {}),
      };
    }
    const base = await this.session.apiBase();
    const token = this.session.session()?.accessToken;
    if (!base || !token) return { ok: false };
    const url = `${base.replace(/\/$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${TAGS_EVENT}/`;
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(content),
      });
      if (res.status === 403) return { ok: false, forbidden: true };
      if (!res.ok) return { ok: false };
      this.cache.set(roomId, { tags: parsePowerLevelTags(content), fetchedAt: Date.now() });
      this.bump();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}
