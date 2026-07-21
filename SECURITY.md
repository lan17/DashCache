# Security Policy

## Supported versions

Only the latest published release of `dialcache` receives security fixes.

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub's private vulnerability
reporting: <https://github.com/lan17/DialCache/security/advisories/new>.
Do not open a public issue for a suspected vulnerability. You will receive an
initial response within 7 days.

## Trust model

- DialCache treats the backing Redis/Valkey deployment as **trusted**. Cached
  values are deserialized with `JSON.parse` and returned without runtime shape
  validation or size limits, so an actor with write access to Redis controls
  the objects returned to callers. Do not point DialCache at an untrusted
  Redis.
- Cache key components (`namespace`, `keyType`, ids, `useCase`, args) are
  URL-encoded before key assembly, so ids cannot inject key delimiters, collide
  across namespaces, or redirect cluster hash slots. Lua scripts are static
  source; dynamic data reaches them only through `KEYS`/`ARGV`.
- `namespace`, `keyType`, and `useCase` are emitted as metrics label values
  unsanitized. Keep them developer-defined constants; never derive them from
  user input.
- DialCache never handles Redis credentials — clients are constructed and
  owned by the caller.
