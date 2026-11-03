import "dotenv/config";
import { z } from "zod";

const optionalValue = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(""),
  ELASTICSEARCH_URL: z.string().url().default("http://localhost:9200"),
  ELASTICSEARCH_API_KEY: optionalValue,
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  MIN_EMAIL_DELAY_SECONDS: z.coerce.number().int().min(0).max(86_400).default(2),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().max(100_000).default(200),
  LOG_LEVEL: z.string().default("info"),
  GOOGLE_CLIENT_ID: optionalValue,
  GOOGLE_CLIENT_SECRET: optionalValue,
  GOOGLE_CALLBACK_URL: z.string().url().default("http://localhost:4000/auth/google/callback"),
  SESSION_SECRET: z.string().min(32).default("local-development-session-secret-change-before-deploy"),
  ENCRYPTION_KEY: optionalValue.refine((value) => value === undefined || /^[0-9a-fA-F]{64}$/.test(value), "Must be 32-byte hex"),
  BULL_BOARD_TOKEN: optionalValue,
  SLACK_CLIENT_ID: optionalValue,
  SLACK_CLIENT_SECRET: optionalValue,
  SLACK_CALLBACK_URL: z.string().url().default("http://localhost:4000/api/slack/callback"),
  ETHEREAL_HOST: z.string().default("smtp.ethereal.email"),
  ETHEREAL_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  ETHEREAL_USER: optionalValue,
  ETHEREAL_PASS: optionalValue,
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
}).superRefine((values, context) => {
  if (values.NODE_ENV === "production") {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
      context.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "Set a production session secret with at least 32 characters" });
    }
    if (!values.GOOGLE_CLIENT_ID || !values.GOOGLE_CLIENT_SECRET) {
      context.addIssue({ code: "custom", path: ["GOOGLE_CLIENT_ID"], message: "Google OAuth credentials are required in production" });
    }
    if (!values.ENCRYPTION_KEY) {
      context.addIssue({ code: "custom", path: ["ENCRYPTION_KEY"], message: "An encryption key is required in production" });
    }
    if (!values.BULL_BOARD_TOKEN) {
      context.addIssue({ code: "custom", path: ["BULL_BOARD_TOKEN"], message: "A queue dashboard token is required in production" });
    }
  }
});

export const env = envSchema.parse(process.env);
