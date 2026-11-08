# Preview deploy

A preview is a second, separate Worker that runs a branch next to production without touching it. It has its own
name and hostname, its own Access application, R2 bucket, Artifacts namespace, AI Gateway, Analytics Engine dataset,
sandbox container and rate-limit namespaces, and its own secrets. Its Durable Objects (chats, users, agents) belong to
it alone, so it starts empty and production's data never reaches it. (This is not Cloudflare's "Preview URLs" feature,
which stays off for both Workers.)

`cloudflare.config.ts` gives production unless `PI_PREVIEW` is set. `deploy/preview.ts` then derives the preview's names
and refuses (the deploy stops with a message) a preview that would reuse anything production keeps data in, that has no
Access audience, or that has a development switch set. `test/deploy-config.test.ts` holds production's config as a fixture
(`test/fixtures/production-config.json`), so a change that alters production fails the tests.

## What the preview gets

| | Production | Preview (`PI_PREVIEW=<name>`) |
| --- | --- | --- |
| Worker | `production.name` in `cloudflare.config.ts` | `<name>` |
| Served on | its custom domain, workers.dev off | `PI_PREVIEW_DOMAIN` (workers.dev off), or `<name>.<account subdomain>.workers.dev` |
| Access | `production.accessTeamDomain`, `accessAud` | production's team (or `PI_PREVIEW_ACCESS_TEAM_DOMAIN`), `PI_PREVIEW_ACCESS_AUD` (required) |
| R2 bucket `FILES`, Artifacts namespace `REPOS` | production's | `<name>` |
| AI Gateway `AI_GATEWAY_ID` | production's | `<name>`, or `PI_PREVIEW_AI_GATEWAY` |
| Analytics Engine dataset `METRICS` | production's | `<name>_metrics`, with underscores for dashes |
| Sandbox container | production's | `<name>-sandbox` |
| Rate limits `PAGE_CALLS`, `PAGE_AI`, `DICTATION`, `AGENT_TURNS` | 4201 to 4204 | each plus 100 (4301 to 4304), or plus `PI_PREVIEW_RATE_LIMIT_OFFSET` |
| `AUTH_MODE`, `DEV_TOOLS`, `DEV_MODEL`, `DEV_PAUSE_MS` | from the environment, for local development | always `access`, off, empty, empty; setting any of them (or `PI_OFFLINE`) stops the deploy |

Everything else is production's, as `cloudflare.config.ts` sets it. That includes the models (`MODEL`, `TITLE_MODEL`, `ROUTER_MODEL`, `AUTO_MODELS`,
`TOOL_PICK_MODEL`, `SKILLS_MODEL`, `CALL_HINT_MODEL`, `CHECK_LOOK_MODEL`, `REVIEW_MODEL`, `PAGE_AI_MODEL`, `DICTATION_MODEL`),
the agents feature's (`AGENT_ROUTER_MODEL`, `INTEREST_MODEL`, `DREAM_MODEL`, `RUNS_DAILY_USD`, `METRICS`, `AGENT_TURNS`),
the allowances (`PAGE_AI_DAILY_USD`, `DICTATION_DAILY_MINUTES`, `MCP_GRANT_DAYS`), and the `AI` and `BROWSER` bindings.
The Durable Objects `ChatAgent`, `UserDirectory`, `Source` and `Sandbox` are new ones for the preview Worker.

Secrets are per Worker, so the preview has none of production's:

- `FILES_MASTER_KEY`: required. Use a new one, never production's.
- `MCP_TOKENS_KEY`: optional. Without it, stored MCP sign-ins are encrypted with a key derived from `FILES_MASTER_KEY`.
- `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, `PUSH_SUBJECT`: optional. Without them nothing is pushed.

## Deploy it

From a checkout of the branch to preview, with Node 22 or later, `pnpm install` done, Docker running (for the sandbox image)
and the Workers Paid plan on the account. Run every step in one shell: the `export`s below are what make it a preview.

1. **Sign in.** Run `npx cf auth login --no-browser`. It prints a link and a code: open the link, check the code and approve
   within 5 minutes.

2. **Name it.** Pick a name of 3 to 48 lowercase letters, digits and dashes, not production's:

   ```sh
   export PI_PREVIEW=app-preview
   unset AUTH_MODE DEV_TOOLS DEV_MODEL DEV_PAUSE_MS PI_OFFLINE
   ```

3. **Create its bucket and gateway.**
   - Run `npx cf r2 buckets create --name "$PI_PREVIEW"`.
   - In the dashboard, under AI → AI Gateway, create a gateway named the same, and store the provider keys the models need
     (Provider Keys). Models on Workers AI need none.
   - Or skip the new gateway, and share production's provider keys with `export PI_PREVIEW_AI_GATEWAY=<production's gateway>`.
     The preview's requests then show up in production's gateway logs and spend.
   - The Artifacts namespace, the Analytics Engine dataset and the container need nothing: they are created on first use
     or by the deploy.

4. **Put it behind Access.** The app accepts only a verified Access token for its own application. Choose one:
   - **A hostname on a zone in the account (simplest):**
     1. In Zero Trust → Access → Applications, add a self-hosted application for, say, `preview.example.com`.
     2. Give it a policy listing who may sign in.
     3. Copy its audience (AUD) tag, then:

        ```sh
        export PI_PREVIEW_DOMAIN=preview.example.com
        export PI_PREVIEW_ACCESS_AUD=<the application's AUD tag>
        ```

        The deploy attaches the hostname to the Worker.
   - **workers.dev (no zone needed):** the Access application for workers.dev can be made only once the Worker exists, so it
     takes two deploys:
     1. First deploy with `export PI_PREVIEW_ACCESS_AUD=pending`. Until the second deploy, every API call is refused, since no
        token has that audience. The page shell (the app's static files, no data) still loads.
     2. Then, under Workers & Pages → `<name>` → Settings → Domains & Routes, turn Cloudflare Access on for workers.dev.
     3. Edit the application it creates under Zero Trust → Access → Applications to set who may sign in.
     4. Copy that application's AUD tag into `PI_PREVIEW_ACCESS_AUD` and deploy again.
   - If your Access team domain is not production's, also set `PI_PREVIEW_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`.

5. **Choose its MCP servers.** Set `PI_MCP_SERVERS` to the servers the preview should reach, as JSON: `[{"name": "…", "url": "…"}]`,
   with `"auth": "oauth"` for those each user signs in to.
   - Without `PI_MCP_SERVERS`, the preview takes `mcp-servers.json` if the checkout has one, else only the public demo server.
   - Sign-ins do not carry over from production: each person signs in again on the preview. A server that accepts only
     registered redirect addresses needs `https://<preview hostname>/api/mcp/oauth/callback` added.
   - The preview's agents can call write tools just as production's can. Give it only servers you are happy for it to change.

6. **Make its secrets.** Generate a file-encryption key with `openssl rand -base64 32`, and if you want push notifications, a
   VAPID pair with `node --experimental-strip-types scripts/vapid-keys.ts`. Write `preview-secrets.json` outside Git:

   ```json
   { "FILES_MASTER_KEY": "…", "PUSH_VAPID_PUBLIC_KEY": "…", "PUSH_VAPID_PRIVATE_KEY": "…", "PUSH_SUBJECT": "mailto:…" }
   ```

   Keep a copy of `FILES_MASTER_KEY` for as long as the preview's files matter.

7. **Check what will deploy, without uploading:**

   ```sh
   npx cf deploy --dry-run
   node -e 'const c = require("./.cloudflare/output/v0/workers/default/worker.config.json"); console.log(c.name, c.domains, c.workersDev, c.env.FILES.name, c.env.REPOS.namespace, c.env.AGENT_TURNS.namespace)'
   ```

   It should print the preview's name everywhere, and 4304 (or your offset). If it prints production's name, `PI_PREVIEW`
   is not set in this shell: stop.

8. **Deploy, then delete the secrets file:**

   ```sh
   npx cf deploy --secrets-file preview-secrets.json --message "preview"
   rm preview-secrets.json
   ```

   Later deploys of the preview are steps 2, 4, 5, 7 and 8 without `--secrets-file`, since the Worker keeps its secrets.

## Click through it

Open the preview's address. Check the Worker's logs (Workers & Pages → `<name>` → Observability) as you go. Then check, in
this order:

1. Access asks you to sign in, and the app opens with your name. A second browser profile, signed in as someone not in the
   policy, is refused.
2. A new chat answers a message, and Auto picks a model if the gateway holds keys.
3. Ask for a small dashboard. The agent checks it in the headless browser and publishes it, and the artifact's link opens it
   with live data.
4. Attach a file and ask about it, which exercises the bucket and the per-user encryption. Ask for a short `run_python`. The
   first sandbox start takes a minute.
5. Agents:
   1. Create one in the sidebar and add it to a chat. Call it with `@name` and get its reply.
   2. Open its window from the people bar. Steer it while it works, and stop it.
   3. Give it a schedule and run it now from its Runs tab.
6. Shared chats: invite a second person (another Access identity) with the chat's link.
   1. They join. `@pi` answers them, and a message without it does not.
   2. Their own agent added to the chat answers as a seat.
   3. Tag them with `@name`, which should send a push notification if you set the VAPID keys and they allowed notifications.
7. For a server with `"auth": "oauth"`: follow the sign-in link the agent gives, and the next call works.
8. Optional: dictation in a browser without speech recognition (Firefox).

## Tear it down

Every command below names `$PI_PREVIEW`. Check it first:

```sh
test -n "$PI_PREVIEW" && test "$PI_PREVIEW" != pi-artifacts && echo "$PI_PREVIEW"
```

1. **The Worker:** `npx cf workers delete "$PI_PREVIEW"`. This deletes its versions, its secrets and its Durable Objects,
   which hold every chat, user, agent and run of the preview. Under Workers & Pages → Custom Domains (or the zone's DNS),
   check that the preview hostname is gone.
2. **The sandbox container:** `npx cf containers applications list`. If `<name>-sandbox` is still listed, delete it with
   `npx cf containers applications delete <its id>`.
3. **Artifacts:**
   1. List the repos: `npx cf artifacts namespaces repos list --namespace "$PI_PREVIEW"`.
   2. Delete each: `npx cf artifacts namespaces repos delete <repo> --namespace "$PI_PREVIEW"`.
   3. Delete the namespace: `npx cf artifacts namespaces delete "$PI_PREVIEW"`.
4. **The bucket:** empty it (in the dashboard, R2 → the bucket → select all → Delete), then
   `npx cf r2 buckets delete "$PI_PREVIEW"`.
5. **The gateway**, only if the preview had its own: `npx cf ai-gateway gateways delete "$PI_PREVIEW"`. Never delete a
   gateway you named in `PI_PREVIEW_AI_GATEWAY`.
6. **Access:** delete the preview's application in Zero Trust → Access → Applications.
7. **The rest:**
   - The Analytics Engine dataset (`<name>_metrics`) holds only counts. The cf CLI has no command to delete it, and it stops
     growing once the Worker is gone.
   - The rate-limit namespaces need nothing.
   - Destroy your copies of the preview's secrets.
