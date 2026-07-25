// Loads a room's member list via the FFI `Room.members()` iterator: pull every
// chunk from the RoomMembersIterator, map each RoomMember to a lightweight value
// type, and expose an immutable snapshot for React.
//
// The SDK returns a `RoomMembersIterator` whose `nextChunk(size)` is synchronous
// and returns `undefined` when exhausted. We drain it fully once. Members are
// filtered to `Join` (the visible roster) and sorted by role then name.

import {
  MembershipState_Tags,
  PowerLevel_Tags,
  RoomMemberRole,
  StateEventType,
  type RoomInterface,
  type RoomMember,
} from "@/matrix";

/** RoomMember.powerLevel is a PowerLevel tagged union; extract the number. */
function powerLevelNumber(m: RoomMember): number {
  const pl = m.powerLevel as { tag: string; inner?: { value: bigint } };
  if (pl?.tag === PowerLevel_Tags.Infinite) return 100; // creator → top tier
  const v = pl?.inner?.value;
  return v == null ? 0 : Number(v);
}
import { ViewModel } from "@/core/reactive";
import type { MatrixSession } from "@/core/MatrixSession";

export type MemberRole = "creator" | "admin" | "moderator" | "user";

export interface MemberEntry {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  role: MemberRole;
  /** Raw power level, for fancy power-level-tag role grouping. */
  powerLevel: number;
}

interface MembersState {
  loading: boolean;
  error: boolean;
  members: MemberEntry[];
  /** Whether the own user may change members' power levels. */
  canChangePowerLevels: boolean;
  /** The own user's power level (promotion ceiling). */
  ownPowerLevel: number;
}

const CHUNK = 100;

function roleOf(m: RoomMember): MemberRole {
  switch (m.suggestedRoleForPowerLevel) {
    case RoomMemberRole.Creator:
      return "creator";
    case RoomMemberRole.Administrator:
      return "admin";
    case RoomMemberRole.Moderator:
      return "moderator";
    default:
      return "user";
  }
}

/** Sort weight: privileged roles first, then alphabetical. */
const ROLE_WEIGHT: Record<MemberRole, number> = {
  creator: 0,
  admin: 1,
  moderator: 2,
  user: 3,
};

export class MembersViewModel extends ViewModel<MembersState> {
  private disposed = false;

  constructor(
    private readonly session: MatrixSession,
    private readonly roomId: string,
  ) {
    super({
      loading: true,
      error: false,
      members: [],
      canChangePowerLevels: false,
      ownPowerLevel: 0,
    });
    this.onDispose(() => {
      this.disposed = true;
    });
  }

  async load(): Promise<void> {
    // Re-arm: React StrictMode runs the mount effect twice (mount→dispose→mount)
    // on the SAME instance, so the surviving mount's load() would otherwise see
    // `disposed = true` from the discarded run and bail → empty roster forever.
    // The base VM keeps its subscribers across dispose(), so reviving is safe.
    this.disposed = false;
    const room = this.session.getRoom(this.roomId) as RoomInterface | undefined;
    if (!room) {
      console.warn(`[MembersViewModel] no room for ${this.roomId}`);
      this.setState({ loading: false, error: true });
      return;
    }
    try {
      let collected = await this.drainMembers(room);
      if (this.disposed) return;

      // In sliding-sync the member list can be empty/partial until the room's
      // timeline has fetched members from the server. If we got nothing, fetch
      // members once via the timeline and drain the iterator again.
      if (collected.length === 0) {
        console.warn(
          `[MembersViewModel] empty roster for ${this.roomId}; fetching members via timeline`,
        );
        try {
          const timeline = await room.timeline();
          if (this.disposed) return;
          await timeline.fetchMembers();
          if (this.disposed) return;
          collected = await this.drainMembers(room);
          if (this.disposed) return;
        } catch (err) {
          console.warn(
            `[MembersViewModel] fetchMembers failed for ${this.roomId}`,
            err,
          );
        }
      }

      // Own power-level, per-user levels, and whether we can re-level members.
      let canChangePowerLevels = false;
      let ownPowerLevel = 0;
      // Authoritative per-user levels straight from the server's power_levels
      // event — the SDK's per-member `powerLevel` (and even getPowerLevels) can
      // lag a recent change, especially in a federated room, which is why a
      // just-promoted admin kept showing under "Member" in the sidebar.
      try {
        const pl = await this.session.roomUserPowerLevels(this.roomId);
        if (this.disposed) return;
        if (pl) {
          const own = pl.users[this.session.userId];
          ownPowerLevel = own !== undefined ? own : pl.usersDefault;
          for (const m of collected) {
            const explicit = pl.users[m.userId];
            if (explicit !== undefined) m.powerLevel = explicit;
            else if (m.powerLevel < pl.usersDefault) m.powerLevel = pl.usersDefault;
          }
        }
      } catch {
        /* fall through to the FFI check below */
      }
      try {
        const levels = await room.getPowerLevels();
        if (this.disposed) return;
        canChangePowerLevels = levels.canOwnUserSendState(StateEventType.RoomPowerLevels);
        if (ownPowerLevel === 0) {
          const own = levels.userPowerLevels().get(this.session.userId);
          ownPowerLevel = own !== undefined ? Number(own) : Number(levels.values().usersDefault);
        }
      } catch {
        /* fail closed: no role menu */
      }

      collected.sort((a, b) => {
        if (a.powerLevel !== b.powerLevel) return b.powerLevel - a.powerLevel;
        return a.displayName.localeCompare(b.displayName, undefined, {
          sensitivity: "base",
        });
      });

      this.setState({
        loading: false,
        error: false,
        members: collected,
        canChangePowerLevels,
        ownPowerLevel,
      });
    } catch (err) {
      console.warn(`[MembersViewModel] load failed for ${this.roomId}`, err);
      if (this.disposed) return;
      this.setState({ loading: false, error: true });
    }
  }

  /** Promote/demote a member. Returns true on success; reloads the roster. */
  async setPowerLevel(userId: string, level: number): Promise<boolean> {
    // REST read-modify-write — the FFI updatePowerLevelsForUsers doesn't reliably
    // persist in the WASM build (promotions silently didn't stick).
    const ok = await this.session.setUserPowerLevel(this.roomId, userId, level);
    if (ok) await this.load();
    else console.warn(`[MembersViewModel] setPowerLevel failed for ${userId}`);
    return ok;
  }

  /** Remove a member from the room (moderator action); reloads the roster. */
  async kick(userId: string, reason?: string): Promise<boolean> {
    const room = this.session.getRoom(this.roomId) as RoomInterface | undefined;
    if (!room) return false;
    try {
      await room.kickUser(userId, reason ?? undefined);
      await this.load();
      return true;
    } catch (err) {
      console.warn(`[MembersViewModel] kick failed for ${userId}`, err);
      return false;
    }
  }

  /** Ban a member from the room (moderator action); reloads the roster. */
  async ban(userId: string, reason?: string): Promise<boolean> {
    const room = this.session.getRoom(this.roomId) as RoomInterface | undefined;
    if (!room) return false;
    try {
      await room.banUser(userId, reason ?? undefined);
      await this.load();
      return true;
    } catch (err) {
      console.warn(`[MembersViewModel] ban failed for ${userId}`, err);
      return false;
    }
  }

  /** Await the members iterator and drain every chunk into joined MemberEntries. */
  private async drainMembers(room: RoomInterface): Promise<MemberEntry[]> {
    const iterator = await room.members();
    const collected: MemberEntry[] = [];
    // `nextChunk` is synchronous and yields `undefined` once drained.
    for (;;) {
      const chunk = iterator.nextChunk(CHUNK);
      if (!chunk || chunk.length === 0) break;
      for (const m of chunk) {
        // Only joined members belong on the visible roster.
        if (m.membership.tag !== MembershipState_Tags.Join) continue;
        collected.push({
          userId: m.userId,
          displayName: m.displayName?.trim() || m.userId,
          avatarUrl: m.avatarUrl ?? undefined,
          role: roleOf(m),
          powerLevel: powerLevelNumber(m),
        });
      }
    }
    return collected;
  }
}

/** Human label for a privileged role; regular users get none. */
export function roleLabel(role: MemberRole): string | undefined {
  switch (role) {
    case "creator":
      return "Owner";
    case "admin":
      return "Admin";
    case "moderator":
      return "Mod";
    default:
      return undefined;
  }
}
