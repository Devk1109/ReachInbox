export type RateLimitReason = "HOURLY_LIMIT" | "MIN_DELAY";

export interface RateLimitResult {
  allowed: boolean;
  retryAt?: Date;
  reason?: RateLimitReason;
}

export const RESERVE_SEND_SLOT_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local hourlyLimit = tonumber(ARGV[1])
local minDelayMs = tonumber(ARGV[2]) * 1000
local windowMs = 3600000
local window = math.floor(now / windowMs)
local hourlyKey = KEYS[1] .. ':' .. window
local sentCount = tonumber(redis.call('GET', hourlyKey) or '0')

if sentCount >= hourlyLimit then
  return {0, (window + 1) * windowMs, 'HOURLY_LIMIT'}
end

local lastSend = tonumber(redis.call('GET', KEYS[2]) or '0')
local nextAllowed = lastSend + minDelayMs
if now < nextAllowed then
  return {0, nextAllowed, 'MIN_DELAY'}
end

local newCount = redis.call('INCR', hourlyKey)
if newCount == 1 then
  redis.call('PEXPIRE', hourlyKey, 7200000)
end
redis.call('SET', KEYS[2], now, 'PX', math.max(minDelayMs, 60000))
return {1, now, ''}
`;

export function parseRateLimitReply(reply: unknown): RateLimitResult {
  if (!Array.isArray(reply) || reply.length < 3) {
    throw new Error("Redis rate limiter returned an invalid response");
  }
  const allowed = Number(reply[0]) === 1;
  const timestamp = Number(reply[1]);
  const reason = reply[2] === "HOURLY_LIMIT" || reply[2] === "MIN_DELAY" ? reply[2] : undefined;
  if (!Number.isFinite(timestamp)) throw new Error("Redis rate limiter returned an invalid retry time");
  if (allowed) return { allowed: true };
  if (!reason) throw new Error("Redis rate limiter returned an unknown block reason");
  return { allowed: false, retryAt: new Date(timestamp), reason };
}

export class RedisRateLimiter {
  constructor(private readonly redis: {
    eval(script: string, numberOfKeys: number, ...values: Array<string | number>): Promise<unknown>;
  }) {}

  async reserveSendSlot(senderId: string, hourlyLimit: number, minDelaySeconds: number): Promise<RateLimitResult> {
    if (!senderId || !Number.isInteger(hourlyLimit) || hourlyLimit < 1 || !Number.isInteger(minDelaySeconds) || minDelaySeconds < 0) {
      throw new Error("Invalid sender rate-limit configuration");
    }
    const senderKey = `{${senderId}}`;
    const reply = await this.redis.eval(
      RESERVE_SEND_SLOT_SCRIPT,
      2,
      `rate_limit:${senderKey}`,
      `last_send:${senderKey}`,
      String(hourlyLimit),
      String(minDelaySeconds),
    );
    return parseRateLimitReply(reply);
  }
}
