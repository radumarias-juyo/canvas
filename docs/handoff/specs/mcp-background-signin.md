# MCP sign-in for scheduled agents (summary of https://claude.ai/artifact/1P8U1DJjSV8cS6F3FBC4yo)

Short answer: keep the per-user sign-in the app already has (`auth: "oauth"` servers, `worker/mcp/oauth.ts`, tokens per
user in `UserDirectory.mcp_auth`), and let a scheduled run use the stored refresh token from Cloudflare Access. No
machine identity for runs that touch a person's data.

- 2FA is not in the way: Cognito and its 2FA are asked only when someone signs in. A refresh goes to Cloudflare Access,
  which issues new tokens and checks its policies again, without asking Cognito.
- What expires is the refresh token, after the portal's *grant session duration* (set in Access; make it longer than the
  longest gap between two runs, e.g. 30 days).
- When a refresh fails, the run stops before it starts work. The owner gets a notice with the sign-in link, and the run
  is tried again after they sign in. They also get a warning a few days before the sign-in runs out.
- A service token on the portal (no person) acts as one shared admin account: only for org-wide data nobody owns.

Security notes: refresh tokens are the real credential (2FA protects new sign-ins, not refreshes); the app is a public
client (no secret), so a refresh token alone is enough to use it: encrypt at rest. Access re-checks its Allow policy on
every refresh, so removing someone works. Rotation is already safe in the app (a refresh that loses a race keeps the
newer tokens). A run should be able to do less than a chat: scheduled runs read only; a write needs the owner's approval.

## Changes in the app (the task)

1. **Encrypt the stored sign-ins.** Today each user's tokens sit as plain JSON in their own storage. Encrypt that record
   with AES-GCM using a per-user key derived from a Worker secret (same pattern as the per-user file key from
   `FILES_MASTER_KEY`). A copy of the storage alone is then not enough.
2. **Remember when the user signed in.** Neither Access nor the OAuth answer says when a refresh token expires. Store the
   sign-in time, and a configured grant length (config, default 30 days) to match Access.
3. **Check the sign-in before a run.** Connect and refresh first. If that ends in "sign in required", mark the run
   *Needs sign-in*, do not start the model, and keep the run so it can go again.
4. **Tell the owner.** A sidebar notice and a browser notification with the existing sign-in link
   (`/api/mcp/sign-in/<name>`), through the same path chat tags use. After the sign-in callback, run the waiting runs.
5. **Warn ahead.** A few days before the stored grant runs out, send one notice with the link.
6. **Limit what a run can do.** Offer a scheduled run only tools marked read-only. A write waits for the owner's approval.
7. **Let users disconnect.** A way to remove a stored sign-in from the account menu.

Before any of this: the per-user portal sign-in has worked only against a local stand-in (`test/mcp-oauth.test.ts`);
the deployed portal refused the code exchange (Cloudflare error 1014). Not something code here can fix; note it.

Open questions (Cloudflare docs): does each refresh extend the grant session or does it end at a fixed time after
sign-in (if fixed, the warning matters more); does an idle portal session end after 24 h for this client type (then a
weekly run would need a daily refresh to stay signed in — a cheap daily keep-alive refresh is the safe default).
