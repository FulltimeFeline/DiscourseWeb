// Extended-profile writers. The SDK exposes no setter for the Commet/MSC4133
// extended-profile fields, so these are direct client-server REST PUTs against
// our own homeserver (session.restPut). Display name and avatar are the only
// FFI-backed fields and are handled by the editor directly (client.setDisplayName,
// client.uploadAvatar, client.removeAvatar).
//
// The editor diffs before calling, so this module just performs the writes.

import type { MatrixSession } from "@/core/MatrixSession";

export interface SocialLink {
  title: string;
  link: string;
  img?: string;
}

function profilePath(session: MatrixSession, key: string): string {
  return `_matrix/client/v3/profile/${encodeURIComponent(session.userId)}/${encodeURIComponent(key)}`;
}

/** Pronouns: write both `pronouns` and `foxchat.pronouns`. */
export async function setPronouns(session: MatrixSession, value: string): Promise<boolean> {
  const a = await session.restPut(profilePath(session, "pronouns"), { pronouns: value });
  const b = await session.restPut(profilePath(session, "foxchat.pronouns"), { "foxchat.pronouns": value });
  return a || b;
}

/** Bio: `chat.commet.profile_bio` as `{ body }`. */
export function setBio(session: MatrixSession, value: string): Promise<boolean> {
  return session.restPut(profilePath(session, "chat.commet.profile_bio"), {
    "chat.commet.profile_bio": { body: value },
  });
}

/** Status: write both presence `status_msg` and `chat.commet.profile_status`. */
export async function setStatus(session: MatrixSession, value: string): Promise<boolean> {
  const presence = await session.restPut(
    `_matrix/client/v3/presence/${encodeURIComponent(session.userId)}/status`,
    { presence: "online", status_msg: value },
  );
  const field = await session.restPut(profilePath(session, "chat.commet.profile_status"), {
    "chat.commet.profile_status": value,
  });
  return presence || field;
}

/** Timezone: write both `m.tz` (MSC4175) and `chat.commet.profile_timezone` (Tuwunel rejects m.tz). */
export async function setTimezone(session: MatrixSession, value: string): Promise<boolean> {
  const std = await session.restPut(profilePath(session, "m.tz"), { "m.tz": value });
  const fallback = await session.restPut(profilePath(session, "chat.commet.profile_timezone"), {
    "chat.commet.profile_timezone": value,
  });
  // The fallback is the one Tuwunel actually keeps; treat its success as success.
  return fallback || std;
}

/** Banner: upload bytes via SDK, then write the mxc to `chat.commet.profile_banner`. */
export async function setBanner(
  session: MatrixSession,
  data: ArrayBuffer,
  mimeType: string,
): Promise<string | undefined> {
  let mxc: string | undefined;
  try {
    mxc = await session.client.uploadMedia(mimeType, data, undefined);
  } catch {
    return undefined;
  }
  if (!mxc) return undefined;
  const ok = await session.restPut(profilePath(session, "chat.commet.profile_banner"), {
    "chat.commet.profile_banner": mxc,
  });
  return ok ? mxc : undefined;
}

export function removeBanner(session: MatrixSession): Promise<boolean> {
  return session.restPut(profilePath(session, "chat.commet.profile_banner"), {
    "chat.commet.profile_banner": "",
  });
}

/**
 * Social links: `foxchat.social_links` as `[{img?,title,link}]`. Blank-link
 * rows are dropped; an empty title defaults to the link.
 */
export function setSocialLinks(session: MatrixSession, links: SocialLink[]): Promise<boolean> {
  const cleaned = links
    .map((l) => ({ ...l, link: l.link.trim(), title: l.title.trim(), img: l.img?.trim() || undefined }))
    .filter((l) => l.link)
    .map((l) => ({
      ...(l.img ? { img: l.img } : {}),
      title: l.title || l.link,
      link: l.link,
    }));
  return session.restPut(profilePath(session, "foxchat.social_links"), {
    "foxchat.social_links": cleaned,
  });
}
