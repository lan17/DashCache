import { DialCacheRedisProtocolError } from "../redis-client.js";

export function validateRedisScriptWriteReply(reply: unknown): 0 | 1 {
  if (reply !== 0 && reply !== 1) {
    throw new DialCacheRedisProtocolError("Invalid DialCache Redis write reply; expected integer 0 or 1");
  }
  return reply;
}

export function validateRedisScriptInvalidationReply(reply: unknown): 1 {
  if (reply !== 1) {
    throw new DialCacheRedisProtocolError("Invalid DialCache Redis invalidate reply; expected integer 1");
  }
  return reply;
}
