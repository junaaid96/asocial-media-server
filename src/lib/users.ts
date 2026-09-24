import { fileUrl } from "../storage.js";

export interface UserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  bio: string;
  institute: string;
  location: string;
  avatar_key: string | null;
  battery: string;
  letters_from: string;
  show_counts: boolean;
  created_at: Date;
}

export const USER_COLUMNS = `id, email, username, display_name, bio, institute, location, avatar_key,
  battery, letters_from, show_counts, created_at`;

export function publicUser(row: Pick<UserRow, "username" | "display_name" | "avatar_key" | "battery">) {
  return {
    username: row.username,
    displayName: row.display_name,
    avatarUrl: fileUrl(row.avatar_key),
    battery: row.battery,
  };
}

export function profileUser(row: UserRow) {
  return {
    ...publicUser(row),
    bio: row.bio,
    institute: row.institute,
    location: row.location,
    lettersFrom: row.letters_from,
    joinedAt: row.created_at,
  };
}

/** The signed-in user's own record, including private settings. */
export function selfUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    ...profileUser(row),
    showCounts: row.show_counts,
  };
}
