# aSocial API

The backend for **aSocial**, a calm social space for introverts. It's an Express 5 + TypeScript API on
**Neon Postgres** and **Neon Object Storage**, deployed as a Vercel Function.

Client: https://github.com/junaaid96/asocial-media-client · Live: https://asocial-media-codejborg.vercel.app

## What's inside

| Feature | How it works |
| --- | --- |
| Accounts | Email/username + password (bcrypt), 30-day JWT bearer tokens |
| Posts | Text up to 3,000 chars, optional photo, **mood** tag, **content note**, **anonymous** mode, daily **prompt** answers |
| Gentle reactions | `felt` · `hug` · `insight` · `relate`. One per person per post. **Quiet counts**: totals are only visible to the author unless they opt in |
| Replies | Threaded under posts. The author's replies stay anonymous on anonymous posts |
| Letters | Pen-pal messages delivered after a delay (`breeze` ≈ 15 min, `afternoon` ≈ 3 h, `overnight` ≈ 12 h). Recipients control who may write (`everyone` / `following` / `nobody`) |
| Social battery | `full` / `half` / `low` / `recharging` status shown on avatars and profiles |
| Follows & kindred spirits | Follow people; suggestions come from people who write in the same moods as you. Follower counts are private |
| Feeds | Latest, Following, Today's prompt, filter by mood. Keyset (cursor) pagination |
| Search | Postgres full-text search over posts (`tsvector` + GIN) and people |
| Notifications | Reactions, replies, follows and letters (a letter notifies only once it arrives) |
| Saved posts, mood garden, account deletion | `/bookmarks`, `/me/moods`, `DELETE /me` |
| Post privacy | `public` · `followers` · `private` (only me), chosen on create/edit and enforced in every feed, profile, search, single-post, reply, reaction and bookmark endpoint |
| Rich text | A small Markdown subset (bold, italic, lists, links, inline/fenced code, @mentions, #hashtags). Sanitized on write: HTML tags and non-http(s)/mailto links are stripped |
| Mentions & hashtags | `@username` notifies people who can see the post (`/users/lookup` powers autocomplete); `#tags` are indexed in `post_tags`, filter feeds with `?tag=`, and `/tags/lookup?q=` suggests tags already used in public posts |
| Reply reactions | Same gentle set as posts, with the same quiet-count rule |
| Daily prompt history | Answers carry the prompt question; `?promptDate=` and `/prompts/:date` list every answer to a prompt |
| Chat | 1:1 conversations with history, unread counts, read receipts, typing and presence over a WebSocket at `/ws` (see below) |
| Reports & moderation | Report a user, post or message with a preset reason; admins review a queue, hide posts and suspend accounts. Reporters hear back when their report is handled, authors are told why a post was hidden (or that it was restored), and every decision lands in an audit log (`/admin/actions`) |
| Time well spent | Clients send short heartbeats of active time; daily totals live in `usage_days`, with an optional daily limit and an optional session reminder (`sessionReminderMinutes`) |
| Uploads | Images are compressed in the browser, checked by magic bytes, and stored in the **private** `asocial-media-uploads` bucket. They're served via `/api/files/*` redirects to presigned URLs, and the redirect is cached at the CDN |

## API overview

All routes are under `/api`. Authenticated routes need `Authorization: Bearer <token>`.

```
POST   /auth/register            POST /auth/login              GET  /auth/me
PATCH  /me                       DELETE /me                    GET  /me/moods
GET    /users/suggested          GET  /users/:username         GET  /users/:username/posts
POST   /users/:username/follow   DELETE /users/:username/follow
GET    /users/:username/connections?kind=followers|following   (own profile only)
GET    /posts?feed=latest|following|prompt&mood=&cursor=        GET  /posts/resonating
GET    /posts/:id                POST /posts                   PATCH/DELETE /posts/:id
PUT    /posts/:id/reaction       DELETE /posts/:id/reaction
POST   /posts/:id/bookmark       DELETE /posts/:id/bookmark    GET  /bookmarks
GET    /posts/:id/comments       POST /posts/:id/comments      PATCH/DELETE /comments/:id
GET    /letters?box=inbox|sent   GET  /letters/:id             POST /letters
GET    /notifications            GET  /notifications/summary   POST /notifications/read
GET    /search?q=                GET  /prompt                  GET  /health
GET    /stats                    (total registered users)
GET    /users/lookup?q=          (mention autocomplete)        GET  /tags/trending
GET    /posts?tag=&promptDate=   GET  /prompts/:date
PUT    /comments/:id/reaction    DELETE /comments/:id/reaction
GET    /conversations            POST /conversations {username} GET /conversations/:id
GET    /conversations/:id/messages?before=|after=<messageId>   POST /conversations/:id/messages {body, clientId}
POST   /conversations/:id/read   GET  /messages/unread
POST   /reports {targetType: user|post|message, username|postId|messageId, reason, details}
POST   /me/usage {day, seconds}  GET  /me/usage
GET    /admin/stats              GET  /admin/users?q=&status=   POST /admin/users/:id/suspend|unsuspend
GET    /admin/posts?q=&status=   POST /admin/posts/:id/hide|unhide
GET    /admin/reports?status=    POST /admin/reports/:id/resolve {action: none|hide_post|suspend_user} | /dismiss
GET    /admin/actions            GET  /tags/lookup?q=
POST   /uploads?kind=avatar|post (raw image body, ≤ 4 MB)       GET  /files/*key
```

## Local development

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, storage credentials
npm run db:migrate            # applies db/migrations/*.sql
npm run dev                   # http://localhost:5000 (REST + chat socket at ws://localhost:5000/ws)
npm run typecheck
npm test                      # end-to-end API tests (use a disposable database)
```

`DATABASE_URL` can point at Neon, or at a local Postgres. Local hosts use a TCP pool; Neon uses the HTTP
serverless driver.

## Real-time chat

The API serves a WebSocket endpoint at `/ws` next to the REST routes, both locally (`src/server.ts`) and on
Vercel (`api/index.ts` exports the `http.Server`, which Vercel Functions can upgrade; this needs Fluid compute). Clients authenticate with their bearer token in the first message
(`{"type":"auth","token":"…"}`), then receive `message`, `read`, `typing`, `presence` and `resync` events.
Messages are always written through the REST API, so the database stays the source of truth; the socket only
pushes updates.

Each socket is pinned to one process (one Function instance on Vercel), and the request that sends a message
may run elsewhere. Events therefore fan out through **Postgres `LISTEN`/`NOTIFY`** on the channel
`asocial_realtime` (`src/fanout.ts`): no extra service. Notes:

- `LISTEN` needs a session, so the listener connects to Neon's direct host (the pooled URL with `-pooler`
  removed, or `DATABASE_URL_DIRECT` if set). Publishing uses the normal pooled/HTTP driver.
- Neon closes idle sessions when the compute scales to zero. The listener reconnects on demand and sends local
  sockets a `resync` event; clients also keep a slow safety poll. Payloads over ~7.5 KB become a `resync` hint
  (Postgres caps `NOTIFY` at 8000 bytes).
- Vercel closes WebSockets when a Function reaches its max duration (300 s on Hobby); the client reconnects.
- Presence is "has a live socket here, or sent a heartbeat in the last 2.5 minutes", so it also works for
  clients that are polling.
- Set `REALTIME_FANOUT=off` to disable cross-instance delivery (single long-running server).

## Admins

There are no built-in admin credentials. Sign up normally, then promote the account:

```bash
DATABASE_URL=… npm run admin:promote -- <username-or-email>
DATABASE_URL=… npm run admin:demote  -- <username-or-email>
```

## Neon

The project is linked to Neon project `wandering-hall-05246979` (branch `production`) through `.neon`.
`neon.ts` declares the private uploads bucket:

```bash
npm i -g neon@latest && neon login
neon link --project-id wandering-hall-05246979 --branch production -y
neon deploy            # applies neon.ts (creates the asocial-media-uploads bucket)
```

Storage credentials: create a branch credential with the `storage:read` and `storage:write` scopes, then map
`token_id` → `AWS_ACCESS_KEY_ID` and `s3_secret_access_key` → `AWS_SECRET_ACCESS_KEY`.

## Deployment (Vercel)

`api/index.ts` is the Vercel Function: it default-exports the `http.Server` from `src/index.ts` (the Express app
plus the WebSocket upgrade handler). `vercel.json` rewrites every path to it, so routes keep their URLs
(`/api/...`, `/ws`), and turns on Fluid compute, which WebSockets need (this project predates it being the
default). Vercel's Express preset alone would serve the app as a plain request handler, without upgrades.
Set these environment variables in the Vercel project (Production):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection string (branch `production`) |
| `JWT_SECRET` | Long random string |
| `AWS_ENDPOINT_URL_S3` | Neon branch storage endpoint |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Neon storage credential |
| `AWS_REGION` | `us-east-2` |
| `STORAGE_BUCKET` | `asocial-media-uploads` |
| `CLIENT_ORIGINS` | Comma-separated client origins, e.g. `https://asocial-media-codejborg.vercel.app` |

Run schema migrations against Neon with `DATABASE_URL=… npm run db:migrate` before deploying schema changes.
`002_chat_privacy_moderation.sql` is additive (new tables, defaulted columns and a widened notification-type
check), so existing rows keep working: every existing post becomes `public`, every user a regular member.
`003_moderation_feedback.sql` is additive too (a `moderation_actions` table, `users.session_reminder_minutes`,
`notifications.body` and two new notification types). Apply it before deploying code that uses it.
