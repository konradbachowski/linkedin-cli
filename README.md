# linkedin-cli

A dead-simple, **zero-dependency** CLI to publish and schedule text posts on **your own** LinkedIn profile.

```bash
linkedin post "Shipped a tiny CLI that posts straight to LinkedIn. No app, one file."
linkedin schedule --at "2026-06-16 09:00" "Goes out tomorrow at 9, even if my laptop is off."
```

- **One file, no dependencies** — just Node 18+ (uses the built-in `fetch`).
- **Your profile only** — uses the `w_member_social` scope. No company pages, no third-party servers, your token stays on your machine.
- **Built-in scheduler** — LinkedIn's API has no native scheduling, so this adds a local queue + a `run-due` command you trigger from cron.
- **Optional remote mode** — keep the queue, token and cron on an always-on box (a $4 VPS) and drive it from your laptop over SSH, so scheduled posts go out on time even when your computer is asleep.

All endpoints and the OAuth flow are verified against the [official LinkedIn docs](https://learn.microsoft.com/en-us/linkedin/).

---

## Install

```bash
git clone https://github.com/konradbachowski/linkedin-cli.git
cd linkedin-cli
npm link        # gives you a global `linkedin` command
# or run without installing:  node linkedin.mjs post "test"
```

## One-time LinkedIn app setup (~3 min)

You need your own LinkedIn app to get a token. This is free and self-serve.

1. Go to https://www.linkedin.com/developers/apps → **Create app**. You'll be asked to attach a Company Page — any page you admin works (we won't post to it).
2. Open the **Products** tab and add:
   - **Share on LinkedIn** → grants `w_member_social` (the permission to post).
   - **Sign In with LinkedIn using OpenID Connect** → lets the CLI fetch your member id automatically.
   Both are self-serve and approved instantly.
3. Generate a token the easy way:
   - Open the **Token Generator**: https://www.linkedin.com/developers/tools/oauth/token-generator
   - Select your app, tick the scopes: `openid`, `profile`, `w_member_social`
   - Click **Generate token** and copy it.

> The Token Generator does the whole OAuth flow for you — you do **not** need to set up redirect URLs or run any OAuth server for this path.

## Log in

```bash
linkedin auth --token "AQ...your_token..."
```

The CLI calls `/userinfo` to resolve your person URN and stores everything in
`~/.config/linkedin-cli/config.json` (chmod 600). Nothing is sent anywhere except LinkedIn.

<details>
<summary>Alternative: browser OAuth (no manual token)</summary>

If you'd rather not paste tokens, you can run the 3-legged OAuth flow. You'll need your
**Client ID / Secret** (from the app's **Auth** tab) and you must add
`http://localhost:8765/callback` to the app's **Authorized redirect URLs**:

```bash
linkedin auth --browser --client-id XXXX --client-secret YYYY
```

If LinkedIn rejects `http://localhost` (some apps require HTTPS redirects), just use the
`--token` path above — it's the zero-friction option.
</details>

## Post

```bash
linkedin post "your post text"
linkedin post --file post.txt
echo "your post text" | linkedin post
linkedin post "text" --visibility connections   # 1st-degree only (default: public)
linkedin post "text" --dry-run                   # print the payload, send nothing
```

On success you get the post URN and a direct link. Check who's logged in:

```bash
linkedin whoami
```

## Schedule

LinkedIn's API publishes immediately — there is no `scheduled_at`. This CLI adds scheduling
with a local queue (`~/.config/linkedin-cli/queue.jsonl`) plus a `run-due` command that
publishes everything that has come due. You run `run-due` periodically from cron.

```bash
linkedin schedule --at "2026-06-16 09:00" "post text"   # time is your LOCAL time
linkedin schedule --at "2026-06-16 09:00" --file post.txt
linkedin queue                  # pending posts
linkedin queue --all            # include sent / errored + links
linkedin unschedule <id>        # cancel a pending post
linkedin run-due                # publish everything that's due (cron calls this)
```

Add a cron entry so the queue is drained automatically (every 5 minutes here):

```cron
*/5 * * * * /usr/local/bin/node /path/to/linkedin-cli/linkedin.mjs run-due >> /tmp/linkedin-cli.log 2>&1
```

> **Caveat:** if `run-due` runs on a laptop that's asleep at the scheduled time, the post
> goes out at the next cron tick after wake (late, not lost). For exact timing, run it on an
> always-on machine — see **Remote mode**.

## Remote mode (schedule from your laptop, publish from a server)

Put the queue, token and cron on an always-on box (any cheap VPS) and drive it from your
laptop. `schedule` / `post` / `queue` / `unschedule` are transparently forwarded over SSH;
`run-due` runs on the server via cron. Scheduled posts then fire on time regardless of your
laptop. Your token only needs to live on the server.

**On the server** (one-time):

```bash
git clone https://github.com/konradbachowski/linkedin-cli.git ~/linkedin-cli
ln -sf ~/linkedin-cli/linkedin.mjs /usr/local/bin/linkedin && chmod +x ~/linkedin-cli/linkedin.mjs
linkedin auth --token "AQ..."     # log in ON the server
( crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/node $HOME/linkedin-cli/linkedin.mjs run-due >> /tmp/linkedin-cli.log 2>&1" ) | crontab -
```

**On your laptop**:

```bash
linkedin remote user@your-server --cmd "/usr/local/bin/node /root/linkedin-cli/linkedin.mjs"
linkedin remote          # show current mode
linkedin remote --off    # back to local mode
```

That's it — `linkedin schedule --at "..." "..."` now lands in the server's queue and the
server publishes it. Times are parsed in **your laptop's** timezone and stored as an absolute
instant, so a server in UTC still fires at the right local moment.

## Token refresh (~every 60 days)

Tokens last 60 days (programmatic refresh is only available to approved LinkedIn partners).
When `whoami` says expired, or a post returns `401`, generate a fresh token in the Token
Generator and run `linkedin auth --token "..."` again (on the server, if you use remote mode).

## Limits & notes

- Rate limit: **150 posts/day** per member.
- Uses the `ugcPosts` endpoint, which is marked legacy but works in 2026. If it's ever shut
  off, switch to `https://api.linkedin.com/rest/posts` with a `LinkedIn-Version: YYYYMM`
  header — it's a one-line change in the `publishPost` helper.
- Text posts only (public / connections visibility). Images are intentionally left out to keep
  it simple; adding them means the `assets?action=registerUpload` flow + `shareMediaCategory: IMAGE`.
- Your token and member id live only in `~/.config/linkedin-cli/config.json`. Nothing is sent
  to any third party — the CLI talks directly to LinkedIn (and, in remote mode, to your own
  server over SSH).

## Commands

| Command | What it does |
|---|---|
| `auth --token "AQ..."` | Log in with a token from the Token Generator |
| `auth --browser` | Log in via the browser OAuth flow (needs client id/secret) |
| `post "text"` | Publish now (`--file`, stdin, `--visibility`, `--dry-run`) |
| `schedule --at "YYYY-MM-DD HH:MM" "text"` | Queue a post for a local time |
| `queue [--all]` | List queued (and sent) posts |
| `unschedule <id>` | Cancel a pending post |
| `run-due` | Publish everything that's due (run from cron) |
| `remote user@host` | Forward commands to a server; `--off` to disable |
| `whoami` | Show the logged-in member + token validity |

## License

MIT
