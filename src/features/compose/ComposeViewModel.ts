// Backing logic for the new-chat / new-room / new-space / join-room flows.
// Wraps the FFI create/join/DM calls with the record shapes from this SDK build:
//   CreateRoomParameters {
//     name?, topic?, isEncrypted, isDirect, visibility: RoomVisibility,
//     preset: RoomPreset, invite?, avatar?, powerLevelContentOverride?,
//     joinRuleOverride?: JoinRule, historyVisibilityOverride?, canonicalAlias?
//   }
// This build has no `isSpace` field on CreateRoomParameters, so a space is
// created via a REST POST to /createRoom with `creation_content.type = m.space`.

import {
  CreateRoomParameters,
  RoomVisibility,
  RoomPreset,
  JoinRule,
  AllowRule,
  type ClientInterface,
} from "@/matrix";
import type { MatrixSession } from "@/core/MatrixSession";

export interface NewRoomInput {
  name: string;
  topic?: string;
  isEncrypted: boolean;
  /** public = published + publicly joinable; private = invite-only. */
  visibility: "public" | "private";
  invite?: string[];
  /** When set, the room is added to this space and gets a restricted join rule. */
  parentSpaceId?: string;
  alias?: string; // local alias part, no leading # or :server
}

export interface NewSpaceInput {
  name: string;
  topic?: string;
  visibility: "public" | "private";
  invite?: string[];
}

/** Start (or reuse) an encrypted DM with a user. Returns the roomId. */
export async function startDirectMessage(
  session: MatrixSession,
  userId: string,
): Promise<string> {
  const existing = session.client.getDmRoom(userId);
  if (existing) return existing.id();
  const params: CreateRoomParameters = {
    name: undefined,
    topic: undefined,
    isEncrypted: true,
    isDirect: true,
    visibility: new RoomVisibility.Private(),
    preset: RoomPreset.TrustedPrivateChat,
    invite: [userId],
    avatar: undefined,
    powerLevelContentOverride: undefined,
    joinRuleOverride: undefined,
    historyVisibilityOverride: undefined,
    canonicalAlias: undefined,
  };
  return session.client.createRoom(params);
}

function getDmRoomSafe(client: ClientInterface, userId: string): string | undefined {
  try {
    return client.getDmRoom(userId)?.id();
  } catch {
    return undefined;
  }
}

/** Create a normal room. Adds it to a parent space (REST) when requested. */
export async function createRoom(
  session: MatrixSession,
  input: NewRoomInput,
): Promise<string> {
  const isPublic = input.visibility === "public";
  const invite = (input.invite ?? []).filter(Boolean);

  // If placed in a space, use a restricted join rule so space members can join.
  const joinRuleOverride =
    input.parentSpaceId && !isPublic
      ? new JoinRule.Restricted({
          rules: [new AllowRule.RoomMembership({ roomId: input.parentSpaceId })],
        })
      : undefined;

  const params: CreateRoomParameters = {
    name: input.name.trim() || undefined,
    topic: input.topic?.trim() || undefined,
    isEncrypted: input.isEncrypted,
    isDirect: false,
    visibility: isPublic ? new RoomVisibility.Public() : new RoomVisibility.Private(),
    preset: isPublic ? RoomPreset.PublicChat : RoomPreset.PrivateChat,
    invite: invite.length ? invite : undefined,
    avatar: undefined,
    powerLevelContentOverride: undefined,
    joinRuleOverride,
    historyVisibilityOverride: undefined,
    canonicalAlias: input.alias?.trim() || undefined,
  };
  const roomId = await session.client.createRoom(params);

  if (input.parentSpaceId) {
    await addChildToSpace(session, input.parentSpaceId, roomId);
    // Inherit the space's roles (power levels + role labels) so space-wide
    // roles auto-apply to new rooms.
    await session.copySpaceRolesToRoom(input.parentSpaceId, roomId).catch(() => {});
  }
  return roomId;
}

/**
 * Create an Element-style video room. FFI `createRoom` can't set
 * `creation_content.type`, so we POST /createRoom directly (same escape hatch as
 * createSpace).
 */
export async function createVideoRoom(
  session: MatrixSession,
  input: NewRoomInput,
): Promise<string | undefined> {
  const isPublic = input.visibility === "public";
  const body: Record<string, unknown> = {
    name: input.name.trim() || undefined,
    topic: input.topic?.trim() || undefined,
    preset: isPublic ? "public_chat" : "private_chat",
    visibility: isPublic ? "public" : "private",
    creation_content: { type: "io.element.video" },
  };
  if (input.parentSpaceId && !isPublic) {
    body.initial_state = [
      {
        type: "m.room.join_rules",
        state_key: "",
        content: {
          join_rule: "restricted",
          allow: [{ type: "m.room_membership", room_id: input.parentSpaceId }],
        },
      },
    ];
  }
  const json = await restPost(session, "_matrix/client/v3/createRoom", body);
  const roomId = json?.room_id;
  if (roomId && input.parentSpaceId) {
    await addChildToSpace(session, input.parentSpaceId, roomId);
    await session.copySpaceRolesToRoom(input.parentSpaceId, roomId).catch(() => {});
  }
  return roomId;
}

/**
 * Create a space. FFI `CreateRoomParameters` has no `isSpace` in this build, so
 * we POST /createRoom directly with `creation_content.type = m.space` (the same
 * REST escape hatch used for video rooms).
 */
export async function createSpace(
  session: MatrixSession,
  input: NewSpaceInput,
): Promise<string | undefined> {
  const isPublic = input.visibility === "public";
  const body = {
    name: input.name.trim() || undefined,
    topic: input.topic?.trim() || undefined,
    preset: isPublic ? "public_chat" : "private_chat",
    visibility: isPublic ? "public" : "private",
    invite: (input.invite ?? []).filter(Boolean),
    creation_content: { type: "m.space" },
    power_level_content_override: { events_default: 100 },
  };
  const json = await restPost(session, "_matrix/client/v3/createRoom", body);
  return json?.room_id;
}

/** Join a room by #alias or !id (optionally with via server hints). */
export async function joinByAddress(
  session: MatrixSession,
  address: string,
  via: string[] = [],
): Promise<string> {
  const room = await session.client.joinRoomByIdOrAlias(address.trim(), via);
  return room.id();
}

/**
 * File a just-created room/space under a parent space (`m.space.child`).
 * Retried: a freshly-created room takes a sync round-trip to exist server-side,
 * so the first PUT can 404/403 before it settles — a single attempt (the old
 * behaviour) silently failed, which is why new rooms never showed up under
 * their space. Returns true once the child event is written.
 */
async function addChildToSpace(
  session: MatrixSession,
  spaceId: string,
  childId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await session.addSpaceChild(spaceId, childId)) {
      // Tell the sidebar to show the room under its space without a manual
      // refresh — the SpacesViewModel only reloads children on space-list diffs,
      // which filing a room doesn't trigger.
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("discourse:room-filed", { detail: { spaceId, roomId: childId } }),
        );
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// A small POST helper (MatrixSession only exposes GET/PUT).
async function restPost(
  session: MatrixSession,
  path: string,
  body: unknown,
): Promise<any | undefined> {
  const base = await session.apiBase();
  if (!base) return undefined;
  const token = session.session()?.accessToken;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

// Re-export the two ids so callers know both the getDmRoom fast-path and create.
export { getDmRoomSafe };
