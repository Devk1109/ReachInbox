import IORedis from "ioredis";
import { env } from "./env";

export function createRedisConnection(): IORedis {
  return new IORedis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}
