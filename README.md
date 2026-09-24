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
POST   /uploads?kind=avatar|post (raw image body, ≤ 4 MB)       GET  /files/*key
```

## Local development

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, storage credentials
npm run db:migrate            # applies db/migrations/*.sql
npm run dev                   # http://localhost:5000
npm run typecheck
npm test                      # end-to-end API tests (use a disposable database)
```

`DATABASE_URL` can point at Neon, or at a local Postgres. Local hosts use a TCP pool; Neon uses the HTTP
serverless driver.

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

Vercel detects Express automatically. `src/index.ts` default-exports the app, so no `vercel.json` is needed.
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
