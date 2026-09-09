// Identity of the caller for a repo/route call — never built from a request
// body or WS frame field, only from the session cookie or DO attachment
// (CLAUDE.md hard rule 4). `src/server/policy/` (M2) will own the assertion
// functions that consume this; repos take it as their first parameter now so
// that convention exists before policy lands.
export type Actor = { userId: string; sessionId: string };
