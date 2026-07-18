import type { DialCacheKeyConfig } from "./config.js";
import type { Serializer } from "./serializer.js";

export interface DialCacheKeyInit {
  readonly keyType: string;
  readonly id: string;
  readonly useCase: string;
  readonly args?: ReadonlyArray<readonly [string, string]>;
  readonly namespace?: string;
  readonly defaultConfig?: DialCacheKeyConfig | null;
  readonly serializer?: Serializer<unknown> | null;
  readonly trackForInvalidation?: boolean;
}

export class DialCacheKey {
  readonly keyType: string;
  readonly id: string;
  readonly useCase: string;
  readonly args: ReadonlyArray<readonly [string, string]>;
  readonly namespace: string;
  readonly prefix: string;
  readonly urn: string;
  readonly defaultConfig: DialCacheKeyConfig | null;
  readonly serializer: Serializer<unknown> | null;
  readonly trackForInvalidation: boolean;

  constructor(init: DialCacheKeyInit) {
    if (Object.hasOwn(init, "urnPrefix")) {
      throw new TypeError('DialCacheKeyInit.urnPrefix was renamed to "namespace"');
    }

    this.keyType = init.keyType;
    this.id = init.id;
    this.useCase = init.useCase;
    this.args = init.args ?? [];
    this.defaultConfig = init.defaultConfig ?? null;
    this.serializer = init.serializer ?? null;
    this.trackForInvalidation = init.trackForInvalidation ?? false;
    this.namespace = init.namespace ?? "urn";
    assertValidNamespace(this.namespace);

    const rawPrefix = joinUrnComponents(this.namespace, this.keyType, this.id);
    this.prefix = this.trackForInvalidation ? redisClusterHashTag(invalidationPrefix(this.namespace, this.keyType, this.id)) : rawPrefix;
    const args = this.args.length > 0 ? `?${this.args.map(([name, value]) => `${encodeComponent(name)}=${encodeComponent(value)}`).join("&")}` : "";
    this.urn = `${this.prefix}${args}#${encodeComponent(this.useCase)}`;
  }

  toString(): string {
    return this.urn;
  }
}

export function normalizeArgs(args: Record<string, string | number | boolean | bigint | null | undefined>): Array<[string, string]> {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [name, String(value)] as [string, string])
    .sort(([left], [right]) => compareCodePoints(left, right));
}

export function invalidationPrefix(namespace: string, keyType: string, id: string): string {
  assertValidNamespace(namespace);
  assertRedisHashTagComponent("keyType", keyType);
  assertRedisHashTagComponent("id", id);
  return joinUrnComponents(namespace, keyType, id);
}

export function assertValidNamespace(namespace: string): void {
  if (namespace.includes("{") || namespace.includes("}")) {
    throw new TypeError('DialCache namespace must not contain "{" or "}"');
  }
}

export function redisClusterHashTag(value: string): string {
  assertRedisHashTagComponent("value", value);
  return `{${value}}`;
}

function assertRedisHashTagComponent(name: string, value: string): void {
  if (value.includes("{") || value.includes("}")) {
    throw new Error(`Redis Cluster hash tag components must not contain braces: ${name}`);
  }
}

function joinUrnComponents(...components: readonly string[]): string {
  return components.map(encodeComponent).join(":");
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
