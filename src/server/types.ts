// Identity of the caller for a repo/route call — never built from a request
// body or WS frame field, only from the session cookie or DO attachment
// (CLAUDE.md hard rule 4). `emailVerified` rides along because policy needs it
// for the invite/message/call gate (docs/05 §2) without a second lookup; the
// M2 requireAuth middleware reads both off the `user`/`session` rows, and M3's
// Better Auth swap keeps the same shape.
export type Actor = { userId: string; sessionId: string; emailVerified: boolean };
