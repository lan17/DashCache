export const REDIS_FRAME_VERSION = 1;
export const REDIS_ENCODING_UTF8 = 0;
export const REDIS_ENCODING_BASE64 = 1;

const WATERMARK_TTL_MARGIN_MS = 60_000;

const PARSE_WATERMARK_LUA = String.raw`local function parse_watermark(raw)
  if not string.match(raw, "^%d+$") and not string.match(raw, "^%d+%.%d+$") then
    return nil
  end
  local value = tonumber(raw)
  if not value or value >= math.huge then
    return nil
  end
  return value
end`;

const CEIL_FINITE_NUMBER_LUA = String.raw`local function ceil_finite_number(raw)
  local value = tonumber(raw)
  if not value or value ~= value or value >= math.huge or value <= -math.huge then
    return nil
  end
  return math.ceil(value)
end`;

const READ_FRAME_LUA = String.raw`local value = redis.call("GET", KEYS[1])
if not value or string.len(value) < 10 then
  return false
end

if string.byte(value, 1) ~= ${REDIS_FRAME_VERSION} then
  return false
end`;

const RETURN_PAYLOAD_LUA = String.raw`return string.sub(value, 10)`;

const VALIDATE_WRITE_ARGUMENTS_LUA = String.raw`local cache_ttl_ms = ceil_finite_number(ARGV[1])
local encoding = tonumber(ARGV[2])
if not cache_ttl_ms or cache_ttl_ms <= 0 then
  return redis.error_reply("ERR invalid GCache TTL")
end
if not encoding or (encoding ~= ${REDIS_ENCODING_UTF8} and encoding ~= ${REDIS_ENCODING_BASE64}) then
  return redis.error_reply("ERR invalid GCache payload encoding")
end`;

const REDIS_TIME_LUA = String.raw`local redis_time = redis.call("TIME")
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)`;

const WRITE_FRAME_LUA = String.raw`local frame = string.char(${REDIS_FRAME_VERSION})
  .. struct.pack(">I8", now_ms)
  .. string.char(encoding)
  .. ARGV[3]
redis.call("SET", KEYS[1], frame, "PX", cache_ttl_ms)`;

export const READ_CACHE_SCRIPT = [READ_FRAME_LUA, RETURN_PAYLOAD_LUA].join("\n\n");

export const READ_TRACKED_CACHE_SCRIPT = [
  PARSE_WATERMARK_LUA,
  READ_FRAME_LUA,
  String.raw`local raw_watermark = redis.call("GET", KEYS[2])
if not raw_watermark then
  return false
end

local watermark = parse_watermark(raw_watermark)
if not watermark then
  return false
end

local created_at = struct.unpack(">I8", string.sub(value, 2, 9))
if created_at <= watermark then
  return false
end`,
  RETURN_PAYLOAD_LUA,
].join("\n\n");

export const WRITE_CACHE_SCRIPT = [
  CEIL_FINITE_NUMBER_LUA,
  VALIDATE_WRITE_ARGUMENTS_LUA,
  REDIS_TIME_LUA,
  WRITE_FRAME_LUA,
  "return 1",
].join("\n\n");

export const WRITE_TRACKED_CACHE_SCRIPT = [
  PARSE_WATERMARK_LUA,
  CEIL_FINITE_NUMBER_LUA,
  VALIDATE_WRITE_ARGUMENTS_LUA,
  String.raw`local watermark_ttl_floor_ms = ceil_finite_number(ARGV[4])
if not watermark_ttl_floor_ms or watermark_ttl_floor_ms <= 0 then
  return redis.error_reply("ERR invalid GCache watermark TTL")
end`,
  REDIS_TIME_LUA,
  String.raw`local raw_watermark = redis.call("GET", KEYS[2])
local watermark = 0
if raw_watermark then
  watermark = parse_watermark(raw_watermark)
  if not watermark then
    return redis.error_reply("ERR invalid GCache watermark")
  end
end

if watermark >= now_ms then
  return 0
end`,
  WRITE_FRAME_LUA,
  String.raw`local desired_ttl_ms = math.max(watermark_ttl_floor_ms, cache_ttl_ms + ${WATERMARK_TTL_MARGIN_MS})
if not raw_watermark then
  redis.call("SET", KEYS[2], "0", "PX", desired_ttl_ms)
else
  local current_ttl_ms = redis.call("PTTL", KEYS[2])
  if current_ttl_ms == -2 then
    redis.call("SET", KEYS[2], raw_watermark, "PX", desired_ttl_ms)
  elseif current_ttl_ms ~= -1 and current_ttl_ms < desired_ttl_ms then
    redis.call("PEXPIRE", KEYS[2], desired_ttl_ms)
  end
end`,
  "return 1",
].join("\n\n");

export const INVALIDATE_CACHE_SCRIPT = [
  PARSE_WATERMARK_LUA,
  CEIL_FINITE_NUMBER_LUA,
  String.raw`local future_buffer_ms = ceil_finite_number(ARGV[1])
local watermark_ttl_floor_ms = ceil_finite_number(ARGV[2])
if not future_buffer_ms or future_buffer_ms < 0 then
  return redis.error_reply("ERR invalid GCache future buffer")
end
if not watermark_ttl_floor_ms or watermark_ttl_floor_ms <= 0 then
  return redis.error_reply("ERR invalid GCache watermark TTL")
end`,
  REDIS_TIME_LUA,
  String.raw`local proposed_watermark = now_ms + future_buffer_ms
local raw_watermark = redis.call("GET", KEYS[1])
local current_watermark = 0

if raw_watermark then
  local parsed_watermark = parse_watermark(raw_watermark)
  if parsed_watermark then
    current_watermark = parsed_watermark
  end
end

local watermark = math.ceil(math.max(current_watermark, proposed_watermark))
local current_ttl_ms = -2
if raw_watermark then
  current_ttl_ms = redis.call("PTTL", KEYS[1])
end
local desired_ttl_ms = math.max(
  watermark_ttl_floor_ms,
  future_buffer_ms + ${WATERMARK_TTL_MARGIN_MS},
  watermark - now_ms + ${WATERMARK_TTL_MARGIN_MS}
)
if current_ttl_ms > desired_ttl_ms then
  desired_ttl_ms = current_ttl_ms
end

local encoded_watermark = string.format("%.0f", watermark)
if current_ttl_ms == -1 then
  redis.call("SET", KEYS[1], encoded_watermark)
else
  redis.call("SET", KEYS[1], encoded_watermark, "PX", desired_ttl_ms)
end`,
  "return 1",
].join("\n\n");
