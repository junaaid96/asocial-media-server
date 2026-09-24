function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get jwtSecret() {
    return required("JWT_SECRET");
  },
  storage: {
    get endpoint() {
      return required("AWS_ENDPOINT_URL_S3");
    },
    get accessKeyId() {
      return required("AWS_ACCESS_KEY_ID");
    },
    get secretAccessKey() {
      return required("AWS_SECRET_ACCESS_KEY");
    },
    region: process.env.AWS_REGION ?? "us-east-2",
    bucket: process.env.STORAGE_BUCKET ?? "asocial-media-uploads",
  },
  clientOrigins: (process.env.CLIENT_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
  isProduction: process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production",
};
