# Ripple

Installable PWA for 1:1 voice calls, text chat, files, camera photos, and voice messages — built for Chrome OS.

Runs entirely on Cloudflare: Workers + Durable Objects + D1 + R2 + Queues.

## Status
Planning complete. Implementation follows the milestones in [docs/09-ROADMAP.md](docs/09-ROADMAP.md).

## Docs
| Doc | Contents |
|---|---|
| [00-PRD](docs/00-PRD.md) | scope, requirements, risks |
| [01-ARCHITECTURE](docs/01-ARCHITECTURE.md) | stack, diagrams, runtime flows |
| [02-DATA-MODEL](docs/02-DATA-MODEL.md) | D1 schema, DO SQLite, authorization matrix, R2, IndexedDB |
| [03-API-CONTRACTS](docs/03-API-CONTRACTS.md) | Edge Functions, Realtime channels, signaling protocol |
| [04-UX-FLOWS](docs/04-UX-FLOWS.md) | routes, screens, permissions, a11y |
| [05-SECURITY](docs/05-SECURITY.md) | threat model, CSP, WebRTC risks, checklist |
| [06-PWA-CHROMEOS](docs/06-PWA-CHROMEOS.md) | manifest, service worker, Chrome OS quirks, audio |
| [07-TESTING](docs/07-TESTING.md) | test pyramid, policy tests, DO tests, WebRTC E2E, CI |
| [08-DEPLOYMENT](docs/08-DEPLOYMENT.md) | environments, runbooks, cost, ops |
| [09-ROADMAP](docs/09-ROADMAP.md) | 14 milestones with exit criteria |
| [10-VIBE-CODING-PLAYBOOK](docs/10-VIBE-CODING-PLAYBOOK.md) | how to drive the build with an agent |

## Quick start
See [docs/08 §3](docs/08-DEPLOYMENT.md).
