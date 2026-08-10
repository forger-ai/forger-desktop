# Workflow app action contract

Desktop workflows can call an installed app deterministically through its local MCP server. This contract is intentionally stricter than the MCP tools available to an agent: an incompatible tool remains usable by an agent, but it does not appear as an **App action** in the workflow editor.

## App manifest

The installed app declares an HTTP MCP process in `manifest.json`:

```json
{
  "mcp": {
    "type": "http",
    "context": ".",
    "command": "<the app's MCP start command>",
    "healthcheck": "/health",
    "toolTimeoutSec": 60
  }
}
```

Desktop starts that process, assigns a loopback port and bearer token, and connects only to the exact `http://127.0.0.1:<port>/mcp` endpoint it created. Tokens stay in the main process and are never exposed to the renderer.

## Eligible tools

An action is selectable only when `tools/list` supplies all of the following:

- a stable `name`, visible title, and description;
- `inputSchema` and `outputSchema` whose root is an object;
- closed object schemas (`additionalProperties: false`) at every object level;
- complete boolean `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` annotations;
- schemas inside the supported, bounded subset described below.

The annotations describe the action in the UI. They are not a security authority: every app action requires explicit approval at execution time, including actions marked read-only and low risk.

Successful `tools/call` responses return an object in `structuredContent`. Text-only responses are not accepted as deterministic outputs.

## Supported schema subset

Every schema node declares exactly one scalar `type`. Desktop accepts:

- `object`: `properties`, an optional unique `required` list contained by those properties, and `additionalProperties: false`;
- `array`: one `items` schema plus optional coherent `minItems` and `maxItems`;
- `string`: optional coherent `minLength` and `maxLength`;
- `number`, `integer`, `boolean`, and `null`;
- an optional non-empty `enum` whose values match the declared type;
- optional `title` and `description`.

Unsupported validation keywords such as `$ref`, `oneOf`, `anyOf`, `allOf`, `const`, `pattern`, `minimum`, and `maximum` make the tool ineligible. Desktop rejects unknown keywords instead of silently weakening the app contract.

Discovery is limited to five pages and 100 tools. Each schema is limited to 256 KiB. Action inputs and structured outputs are limited to 1 MiB, 32 levels of JSON depth, and 5,000 object keys; unsafe object keys are rejected.

## Stable identity and updates

The workflow node stores the app ID, exact tool name, visible metadata, schemas, effect, risk, idempotency, and a canonical SHA-256 contract hash. Desktop repeats discovery for every run and verifies that hash immediately before each call. A missing app, missing action, incompatible schema, or changed hash blocks the whole workflow before any app action begins.

Compatible changes must preserve the complete captured contract. A changed contract requires the person to review and apply a new workflow revision; Desktop never substitutes an action by a similar name.

## Data and errors

The raw structured output exists in memory only while the run needs it for downstream mappings. Workflow history stores bounded receipts with common secret-bearing keys redacted. Apps must not put credentials, bearer tokens, cookies, private keys, or other secrets in action inputs or outputs.

Errors use stable technical codes. A multi-app preflight is fail-closed: if any required app MCP cannot start or any required action is incompatible, no action in the workflow is called. Apps should use idempotent operations when possible, but Desktop does not automatically retry a mutation based only on MCP annotations.

## Compatibility verification

An app adopting this contract should add an integration test that starts its real MCP process and proves:

1. `tools/list` exposes the expected complete schemas and annotations;
2. `tools/call` accepts the declared input and returns the declared structured object;
3. its contract hash remains stable across a compatible release;
4. secrets do not appear in either input or structured output;
5. destructive or externally visible effects can be exercised safely in a dedicated test environment.

Desktop includes a two-server vertical fixture that verifies App A output mapping into App B without an LLM, including fail-closed behavior. That fixture validates the platform integration; it does not claim compatibility for a published app until the app's own repository adopts and tests this contract.
