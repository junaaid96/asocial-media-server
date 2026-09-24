import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env.js";

let client: S3Client | undefined;

function s3(): S3Client {
  client ??= new S3Client({
    region: env.storage.region,
    endpoint: env.storage.endpoint,
    credentials: {
      accessKeyId: env.storage.accessKeyId,
      secretAccessKey: env.storage.secretAccessKey,
    },
    // Neon Object Storage only supports path-style addressing.
    forcePathStyle: true,
  });
  return client;
}

export const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export type ImageType = keyof typeof IMAGE_TYPES;

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Sniff the first bytes so a renamed file can't masquerade as an image. */
export function sniffImageType(buf: Buffer): ImageType | undefined {
  if (buf.length < 12) return undefined;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  return undefined;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.storage.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: env.storage.bucket, Key: key }));
  } catch (error) {
    // Orphaned files are harmless; never fail the user's action because of cleanup.
    console.warn("Failed to delete object", key, error);
  }
}

/** The bucket is private, so files are served through short-lived presigned URLs. */
export function signedDownloadUrl(key: string, expiresIn = 60 * 60 * 24 * 7): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.storage.bucket, Key: key }), { expiresIn });
}

/** Keys are namespaced per user: `<kind>/<userId>/<uuid>.<ext>`. */
export const KEY_PATTERN = /^(avatars|posts)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

export function ownsKey(key: string, kind: "avatars" | "posts", userId: string): boolean {
  return KEY_PATTERN.test(key) && key.startsWith(`${kind}/${userId}/`);
}

export function fileUrl(key: string | null | undefined): string | null {
  return key ? `/api/files/${key}` : null;
}
