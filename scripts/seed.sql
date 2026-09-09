-- Local dev / test fixture data. Matches the A/B/C/D fixture docs/07 §2 uses
-- for the M2 policy suite: A and B are friends, C is a stranger, D is
-- blocked by A. Run with `pnpm db:seed` (see package.json).
--
-- Passwords are not seeded here — Better Auth's `account` table lands in M3.

INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
  ('usr_a', 'Alice',  'alice@example.com',  1, 1735689600000, 1735689600000),
  ('usr_b', 'Bob',    'bob@example.com',    1, 1735689600000, 1735689600000),
  ('usr_c', 'Carol',  'carol@example.com',  1, 1735689600000, 1735689600000),
  ('usr_d', 'Dave',   'dave@example.com',   1, 1735689600000, 1735689600000);

INSERT INTO profiles (user_id, display_name, created_at) VALUES
  ('usr_a', 'Alice', 1735689600000),
  ('usr_b', 'Bob',   1735689600000),
  ('usr_c', 'Carol', 1735689600000),
  ('usr_d', 'Dave',  1735689600000);

-- usr_a / usr_b: accepted friendship + conversation
INSERT INTO friendships (id, user_a, user_b, requested_by, status, created_at, updated_at) VALUES
  ('fr_ab', 'usr_a', 'usr_b', 'usr_a', 'accepted', 1735689600000, 1735689600000);

INSERT INTO conversations (id, friendship_id, created_at) VALUES
  ('conv_ab', 'fr_ab', 1735689600000);

INSERT INTO conversation_members (conversation_id, user_id) VALUES
  ('conv_ab', 'usr_a'),
  ('conv_ab', 'usr_b');

-- usr_a blocked usr_d
INSERT INTO friendships (id, user_a, user_b, requested_by, status, blocked_by, created_at, updated_at) VALUES
  ('fr_ad', 'usr_a', 'usr_d', 'usr_d', 'blocked', 'usr_a', 1735689600000, 1735689600000);
