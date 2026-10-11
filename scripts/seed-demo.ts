// Create or refresh the public demo accounts (safe to re-run).
//
//   npx tsx --env-file-if-exists=.env scripts/seed-demo.ts
import bcrypt from "bcryptjs";
import pg from "pg";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "../src/lib/demo.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const bios: Record<string, string> = {
    demo_member: "Just looking around the calm corner of the internet. 🌿",
    demo_admin: "Demo moderator: can see the admin dashboard, but actions are switched off.",
  };
  for (const a of DEMO_ACCOUNTS) {
    const { rows: [u] } = await client.query<{ id: string }>(
      `INSERT INTO users (email, username, display_name, password_hash, bio, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
         password_hash = EXCLUDED.password_hash, bio = EXCLUDED.bio, role = EXCLUDED.role, suspended_at = NULL
       RETURNING id`,
      [a.email, a.username, a.displayName, hash, bios[a.username] ?? "", a.role],
    );
    // Follow a few of the most active real members so the home feed isn't empty.
    await client.query(
      `INSERT INTO follows (follower_id, followee_id)
       SELECT $1, p.author_id FROM posts p JOIN users x ON x.id = p.author_id
       WHERE p.author_id <> $1 AND x.username <> ALL($2)
       GROUP BY p.author_id ORDER BY count(*) DESC LIMIT 6
       ON CONFLICT DO NOTHING`,
      [u!.id, DEMO_ACCOUNTS.map((d) => d.username)],
    );
  }
  await client.query("COMMIT");
  console.log(`Demo accounts ready: ${DEMO_ACCOUNTS.map((a) => "@" + a.username).join(", ")}`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
