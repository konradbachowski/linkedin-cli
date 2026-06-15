---
name: linkedin
description: Publish and schedule text posts on the user's own LinkedIn profile via the zero-dependency `linkedin` CLI (github.com/konradbachowski/linkedin-cli). Use when the user wants to post to LinkedIn, schedule a post for a specific time, review or cancel their queue of scheduled posts, or work on a series of LinkedIn content. Triggers - "post to linkedin", "publish on linkedin", "schedule a linkedin post", "linkedin post", "my linkedin queue", "what's scheduled on linkedin", "cancel scheduled post".
---

# LinkedIn CLI

Drive the `linkedin` CLI to publish and schedule text posts on the user's **own** LinkedIn
profile. Use this instead of hand-crafting `curl` calls to the LinkedIn API.

- **Repo / source:** https://github.com/konradbachowski/linkedin-cli
- **Binary:** `linkedin` (after `npm link`) or `node /path/to/linkedin.mjs`
- **Config:** `~/.config/linkedin-cli/config.json` (chmod 600) — holds the token, the member
  URN, and optionally a `remote` target. Never print or commit this file.
- **Endpoint:** `POST https://api.linkedin.com/v2/ugcPosts` (verified against LinkedIn docs).

## Mental model (read first)

- **Text only, the user's profile only.** Scope is `w_member_social`. No company pages, no
  images (text + public/connections visibility).
- **LinkedIn has no native scheduling** — the API publishes immediately. Scheduling is a local
  queue (`queue.jsonl`) plus `run-due`, which a cron job calls periodically to publish what's due.
- **Two modes:**
  - **local** — queue + publish on this machine. Simple, but if the machine is asleep at the
    scheduled time the post fires late (at the next cron tick), not on time.
  - **remote** — queue + token + cron live on an always-on server; `schedule`/`post`/`queue`/
    `unschedule` are forwarded over SSH. Posts fire on time regardless of this machine. Check
    with `linkedin remote`.
- **Timezone:** scheduled times are parsed in the **local** timezone and stored as an absolute
  UTC instant. Don't manually convert times — just pass the user's local wall-clock time.

## Before acting

1. Confirm login: `linkedin whoami`. If it reports the token is expired, tell the user to
   regenerate one (see Token refresh) — do not try to publish.
2. **Publishing is public and hard to undo.** Before a real `post` (not `--dry-run`) or before
   scheduling, confirm the exact text with the user unless they've clearly approved it.
3. For multi-line text or text with quotes, use `--file` or stdin (heredoc) rather than a
   quoted argument, to avoid shell-escaping bugs.

## Commands

```bash
# publish now
linkedin post "post text"
linkedin post --file post.txt
echo "post text" | linkedin post
linkedin post "text" --visibility connections   # 1st-degree only (default: public)
linkedin post "text" --dry-run                   # print payload, send nothing — use to preview

# schedule (local wall-clock time)
linkedin schedule --at "2026-06-16 09:00" "post text"
linkedin schedule --at "2026-06-16 09:00" --file post.txt

# manage the queue
linkedin queue            # pending posts (times shown in local tz)
linkedin queue --all      # include sent / errored + post links
linkedin unschedule <id>  # cancel a pending post

# diagnostics
linkedin whoami           # who's logged in + token validity
linkedin remote           # show mode (remote/local)
```

## Setup (only if not yet configured)

If `linkedin whoami` fails with "not logged in", walk the user through setup — it's a one-time,
self-serve LinkedIn app + token, fully documented in the repo README:

1. Create a LinkedIn app at https://www.linkedin.com/developers/apps and add the **Share on
   LinkedIn** and **Sign In with LinkedIn using OpenID Connect** products (instant, self-serve).
2. Generate a token at the **Token Generator**
   (https://www.linkedin.com/developers/tools/oauth/token-generator) with scopes
   `openid`, `profile`, `w_member_social`.
3. `linkedin auth --token "AQ..."`

## Scheduling on a server (remote mode)

To make scheduled posts fire on time even when the user's laptop is off, the queue + cron run
on an always-on box. Setup is in the README ("Remote mode"). Quick checks:

```bash
linkedin remote                                   # current mode
linkedin remote user@host --cmd "/usr/local/bin/node /root/linkedin-cli/linkedin.mjs"  # enable
linkedin remote --off                             # back to local
```

The server runs `*/5 * * * * node /path/to/linkedin.mjs run-due` via cron.

## Token refresh (~every 60 days)

Tokens last 60 days (no programmatic refresh for non-partners). When `whoami` says expired or a
post returns `401`: regenerate in the Token Generator, then `linkedin auth --token "..."`
(on the **server** if remote mode is on).

## Limits & gotchas

- Rate limit: **150 posts/day** per member.
- `ugcPosts` is legacy but works; if it ever stops, switch to `https://api.linkedin.com/rest/posts`
  + `LinkedIn-Version: YYYYMM` header (one line in the `publishPost` helper).
- Success = HTTP 201 + post URN in the `x-restli-id` header; the CLI prints a
  `https://www.linkedin.com/feed/update/{urn}/` link.
- For batch scheduling many posts, prefer `--file` over piping each one via stdin. Stdin reading
  is hardened (blocking read with EAGAIN retry), but `--file` is the most predictable in loops.
