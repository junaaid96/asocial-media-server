// Live chat delivery over Ably (https://ably.com), the managed pub/sub that suits serverless:
// Vercel Functions write to the database, then publish over Ably's REST API; browsers hold a
// single Ably Realtime connection authenticated with short-lived, narrowly scoped tokens.
//
// Channels (user ids are UUIDs):
//   asocial:user:<id>      the user's private inbox: new messages, read receipts, typing.
//                          Only the server publishes; the owner may only subscribe.
//   asocial:presence:<id>  the user's own presence channel. The owner may enter presence;
//                          people they have a conversation with may subscribe to see them online.
// The root API key (ABLY_API_KEY) never leaves the server.
import * as Ably from "ably";

export const TOKEN_TTL_MS = 60 * 60_000;
/** Most recent conversation partners whose presence a token may watch. */
export const MAX_PRESENCE_PARTNERS = 200;

export const inboxChannel = (userId: string) => `asocial:user:${userId}`;
export const presenceChannel = (userId: string) => `asocial:presence:${userId}`;

export function ablyEnabled() {
  return !!process.env.ABLY_API_KEY;
}

let rest: Ably.Rest | undefined;
function client(): Ably.Rest {
  rest ??= new Ably.Rest({ key: process.env.ABLY_API_KEY!, queryTime: false });
  return rest;
}

/** The token capability for a user: their own inbox (subscribe), their own presence, partners' presence. */
export function capabilityFor(userId: string, partnerIds: string[]): Record<string, Ably.CapabilityOp[]> {
  const capability: Record<string, Ably.CapabilityOp[]> = {
    [inboxChannel(userId)]: ["subscribe"],
    [presenceChannel(userId)]: ["presence", "subscribe"],
  };
  for (const partner of partnerIds.slice(0, MAX_PRESENCE_PARTNERS)) {
    if (partner !== userId) capability[presenceChannel(partner)] = ["subscribe"];
  }
  return capability;
}

/** A signed token request the browser exchanges with Ably. Created locally; no network call. */
export async function tokenRequestFor(userId: string, partnerIds: string[]) {
  return client().auth.createTokenRequest({
    clientId: userId,
    capability: JSON.stringify(capabilityFor(userId, partnerIds)),
    ttl: TOKEN_TTL_MS,
  });
}

type Publisher = (channel: string, name: string, data: unknown) => Promise<void>;

const defaultPublisher: Publisher = async (channel, name, data) => {
  await client().channels.get(channel).publish(name, data);
};
let publisher: Publisher = defaultPublisher;

/** Tests swap the publisher so nothing reaches Ably. */
export function setAblyPublisher(next: Publisher | null) {
  publisher = next ?? defaultPublisher;
}

/** Publishes an event to each user's inbox. Never throws: the REST API stays the source of truth. */
export async function publishToUsers(userIds: Iterable<string>, event: { type: string } & Record<string, unknown>) {
  if (!ablyEnabled()) return;
  await Promise.all(
    [...new Set(userIds)].map((id) =>
      publisher(inboxChannel(id), event.type, event).catch((error: unknown) => {
        console.warn("ably publish failed:", (error as Error).message);
      }),
    ),
  );
}
