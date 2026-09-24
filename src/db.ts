import { neon } from "@neondatabase/serverless";
import pg from "pg";
import { env } from "./env.js";

export type Row = Record<string, unknown>;

export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

function createDb(): Db {
  const url = env.databaseUrl;
  // Neon's HTTP driver is the fastest option from serverless functions. For a
  // local Postgres (development/tests) fall back to a regular TCP pool.
  if (process.env.DB_DRIVER === "pg" || /@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    return {
      async query<T>(text: string, params: unknown[] = []) {
        const result = await pool.query(text, params);
        return result.rows as T[];
      },
    };
  }
  const sql = neon(url);
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.query(text, params)) as T[];
    },
  };
}

let instance: Db | undefined;

export const db: Db = {
  query(text, params) {
    instance ??= createDb();
    return instance.query(text, params);
  },
};

export async function one<T = Row>(text: string, params?: unknown[]): Promise<T | undefined> {
  const rows = await db.query<T>(text, params);
  return rows[0];
}
