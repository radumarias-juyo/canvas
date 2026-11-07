import { signInNoticeText, type McpSignInView, type SignInNotice, type SignInNoticeKind } from "../../shared/sign-ins.ts";
import { errorMessage } from "../../shared/util.ts";
import type { Sql } from "../members.ts";
import { checkSignIn, grantMs, KEEP_ALIVE_MS, KEEP_ALIVE_RETRY_MS, warnAt, type SignInCheck } from "./background.ts";
import { applyAuthChange, signInPath, type McpAuthChange, type McpAuthRecord, type McpAuthStore } from "./oauth.ts";
import { openAuthRecord, sealAuthRecord } from "./sealed.ts";
import { mcpServers, type McpServerConfig } from "./servers.ts";

type AuthRow = { server: string; data: string; signed_in: number; signed_in_at: number | null; warned_at: number; keep_at: number };

/** What the sign-ins need from the UserDirectory they live in. */
export interface SignInsHost {
  sql: Sql;
  env: { MCP_SERVERS?: unknown; MCP_GRANT_DAYS?: unknown };
  /** The user's key for their sign-in records (mcpTokensKey). */
  key: () => Promise<CryptoKey>;
  /** The list of sign-ins changed: open sidebars read it again. */
  changed: () => void;
  /** Tell the user: the sidebar's socket, and a push when no app is open. */
  notify: (notice: SignInNotice, push: { title: string; body: string; url: string; tag: string }) => Promise<void>;
  /** The user signed in to `server` again: tell one of their chats with runs waiting on it (ChatAgent.signedIn). */
  signedIn: (chatId: string, server: string) => Promise<void>;
  /** When the next warning or keep-alive is due; null for none. */
  setAlarm: (at: number | null) => void;
  /** Tests pass a check and a clock. */
  check?: (server: McpServerConfig, store: McpAuthStore) => Promise<SignInCheck>;
  now?: () => number;
}

/**
 * One user's sign-ins to servers that sign in each user, in their UserDirectory's SQLite:
 *
 * - `mcp_auth`: one row per server, the record (client registration, tokens, a sign-in in progress) sealed with the
 *   user's key (worker/mcp/sealed.ts), beside what needs no secret: whether there are tokens, when the grant started,
 *   the grant it already warned about, and when the next keep-alive refresh is due. A row written before encryption is
 *   sealed the first time it is read.
 * - `mcp_run_servers`: the servers each chat's scheduled runs use. Only those are kept alive and warned about: a person
 *   in a chat signs in when the agent gives them the link, a run cannot.
 * - `mcp_waiting`: chats with runs waiting for a sign-in, told when it comes (`onSignedIn`).
 * - `mcp_notices`: what the sidebar shows until the user signs in, or dismisses it.
 *
 * Records are read and changed one call at a time: opening one awaits, and a sign-in and the refreshes of several
 * chats must not overwrite each other.
 */
export class McpSignIns {
  readonly #host: SignInsHost;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(host: SignInsHost) {
    this.#host = host;
    this.#now = host.now ?? Date.now;
    const { sql } = host;
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_auth (server TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    const columns = new Set(
      sql
        .exec("SELECT name FROM pragma_table_info('mcp_auth')")
        .toArray()
        .map((row) => row.name),
    );
    if (!columns.has("signed_in")) {
      sql.exec("ALTER TABLE mcp_auth ADD COLUMN signed_in INTEGER NOT NULL DEFAULT 0");
      sql.exec("ALTER TABLE mcp_auth ADD COLUMN signed_in_at INTEGER");
      sql.exec("ALTER TABLE mcp_auth ADD COLUMN warned_at INTEGER NOT NULL DEFAULT 0");
      sql.exec("ALTER TABLE mcp_auth ADD COLUMN keep_at INTEGER NOT NULL DEFAULT 0");
      // Rows from before are plain JSON: when they were signed in is unknown, so the grant counts from now.
      sql.exec(
        "UPDATE mcp_auth SET signed_in = 1, signed_in_at = ? WHERE data LIKE '{%' AND json_extract(data, '$.tokens.access_token') IS NOT NULL",
        this.#now(),
      );
    }
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_run_servers (chat_id TEXT NOT NULL, server TEXT NOT NULL, PRIMARY KEY (chat_id, server));
      CREATE TABLE IF NOT EXISTS mcp_waiting (server TEXT NOT NULL, chat_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (server, chat_id));
      CREATE TABLE IF NOT EXISTS mcp_notices (server TEXT PRIMARY KEY, kind TEXT NOT NULL, what TEXT, ends_at INTEGER, at INTEGER NOT NULL);
    `);
    // Forget sign-ins to servers this deployment no longer has, tokens included.
    const configured = this.#oauthServers().map((server) => server.name);
    const notIn = configured.length ? ` WHERE server NOT IN (${configured.map(() => "?").join(", ")})` : "";
    for (const table of ["mcp_auth", "mcp_run_servers", "mcp_waiting", "mcp_notices"]) sql.exec(`DELETE FROM ${table}${notIn}`, ...configured);
  }

  /** The store a connection of this user's uses for one server (McpOAuthClient). */
  store(server: string): McpAuthStore {
    return { get: () => this.record(server), update: (change) => this.update(server, change) };
  }

  record(server: string): Promise<McpAuthRecord> {
    return this.#serially(() => this.#read(server));
  }

  update(server: string, change: McpAuthChange): Promise<void> {
    return this.#serially(async () => {
      const before = await this.#read(server);
      await this.#write(server, before, applyAuthChange(before, change));
    });
  }

  /** The account menu's list: every server that signs in each user, signed in or not. */
  list(): McpSignInView[] {
    const grant = grantMs(this.#host.env);
    const rows = new Map(this.#rows().map((row) => [row.server, row]));
    const runs = new Set(this.#runServers());
    const notices = new Map(
      this.#host.sql
        .exec("SELECT server, kind, what FROM mcp_notices")
        .toArray()
        .map((row) => [row.server as string, { kind: row.kind as SignInNoticeKind, what: row.what as string | null }]),
    );
    return this.#oauthServers().map(({ name }) => {
      const row = rows.get(name);
      const signedInAt = row?.signed_in ? (row.signed_in_at ?? undefined) : undefined;
      return {
        server: name,
        signedIn: row?.signed_in === 1,
        ...(signedInAt !== undefined && { signedInAt, endsAt: signedInAt + grant }),
        usedByRuns: runs.has(name),
        link: signInPath(name),
        ...(notices.has(name) && { notice: notices.get(name)!.kind }),
        ...(notices.get(name)?.what && { waiting: notices.get(name)!.what! }),
      };
    });
  }

  /** Remove a stored sign-in (the account menu's Disconnect). Runs that need it ask for a new one. */
  disconnect(server: string): Promise<boolean> {
    return this.#serially(async () => {
      const removed = this.#host.sql.exec("DELETE FROM mcp_auth WHERE server = ?", server).rowsWritten > 0;
      this.#host.sql.exec("DELETE FROM mcp_notices WHERE server = ?", server);
      this.#host.changed();
      this.#schedule();
      return removed;
    });
  }

  /**
   * The servers a chat's scheduled runs use (worker/agents/runs): replaces that chat's list; an empty list clears it.
   * Those are refreshed daily and warned about before their grant ends.
   */
  setRunServers(chatId: string, servers: readonly string[]): void {
    const oauth = new Set(this.#oauthServers().map((server) => server.name));
    this.#host.sql.exec("DELETE FROM mcp_run_servers WHERE chat_id = ?", chatId);
    for (const server of new Set(servers)) {
      if (oauth.has(server)) this.#host.sql.exec("INSERT INTO mcp_run_servers (chat_id, server) VALUES (?, ?)", chatId, server);
    }
    this.#host.changed();
    this.#schedule();
  }

  /**
   * Check, before a run starts, that each of `servers` can be used with nobody present: refresh the sign-in of each that
   * signs in each user (servers that do not are `ok`; a name this deployment lacks is `unavailable`). A run with any
   * `needs_sign_in` does not start: it calls `needed`, and goes again once the user signs in.
   */
  async check(servers: readonly string[]): Promise<Record<string, SignInCheck>> {
    const configs = new Map(mcpServers(this.#host.env).map((server) => [server.name, server]));
    const results = await Promise.all(
      [...new Set(servers)].map(async (name): Promise<[string, SignInCheck]> => {
        const config = configs.get(name);
        if (!config) return [name, "unavailable"];
        if (config.auth !== "oauth") return [name, "ok"];
        return [name, await this.#check(config)];
      }),
    );
    return Object.fromEntries(results);
  }

  /**
   * A run, or the daily refresh, found that `server` needs a new sign-in: show a notice with the sign-in link (the
   * sidebar, the browser, a push when no app is open), once until they sign in. With `chatId`, that chat's waiting runs
   * are told when they do. `what` says what is waiting ("Daily brief").
   */
  async needed(server: string, context: { chatId?: string; what?: string } = {}): Promise<void> {
    if (!this.#oauthServers().some((s) => s.name === server)) return;
    const now = this.#now();
    if (context.chatId) this.#host.sql.exec("INSERT OR IGNORE INTO mcp_waiting (server, chat_id, at) VALUES (?, ?, ?)", server, context.chatId, now);
    const existing = this.#host.sql.exec("SELECT kind FROM mcp_notices WHERE server = ?", server).toArray()[0];
    if (existing?.kind === "needed") return;
    const what = context.what?.slice(0, 80);
    this.#host.sql.exec(
      "INSERT INTO mcp_notices (server, kind, what, ends_at, at) VALUES (?, 'needed', ?, NULL, ?) ON CONFLICT(server) DO UPDATE SET kind = 'needed', what = excluded.what, ends_at = NULL, at = excluded.at",
      server,
      what ?? null,
      now,
    );
    await this.#tell({ type: "sign-in", server, kind: "needed", link: signInPath(server), ...(what && { what }), at: now });
  }

  /**
   * The user finished signing in to `server` (the OAuth callback): a new grant starts now, its notice goes, and every
   * chat with runs waiting on it is told.
   */
  async onSignedIn(server: string): Promise<void> {
    const sql = this.#host.sql;
    const now = this.#now();
    sql.exec("UPDATE mcp_auth SET signed_in_at = ?, warned_at = 0, keep_at = ? WHERE server = ? AND signed_in = 1", now, now + KEEP_ALIVE_MS, server);
    sql.exec("DELETE FROM mcp_notices WHERE server = ?", server);
    const chats = sql
      .exec("SELECT chat_id FROM mcp_waiting WHERE server = ?", server)
      .toArray()
      .map((row) => row.chat_id as string);
    sql.exec("DELETE FROM mcp_waiting WHERE server = ?", server);
    this.#host.changed();
    this.#schedule();
    const told = await Promise.allSettled(chats.map((chatId) => this.#host.signedIn(chatId, server)));
    for (const result of told) if (result.status === "rejected") console.error("signed in: telling a chat failed:", result.reason);
  }

  /** Dismiss a notice; it comes back when a run needs the sign-in again. */
  dismiss(server: string): void {
    if (this.#host.sql.exec("DELETE FROM mcp_notices WHERE server = ?", server).rowsWritten) this.#host.changed();
  }

  /** The alarm: warn about grants ending soon (once per grant), refresh the sign-ins runs use, then set the next alarm. */
  async alarm(): Promise<void> {
    const now = this.#now();
    const grant = grantMs(this.#host.env);
    const runs = new Set(this.#runServers());
    const rows = this.#rows().filter((row) => row.signed_in === 1 && runs.has(row.server));
    for (const row of rows) {
      if (row.signed_in_at === null || row.warned_at === row.signed_in_at || warnAt(row.signed_in_at, grant) > now) continue;
      this.#host.sql.exec("UPDATE mcp_auth SET warned_at = ? WHERE server = ?", row.signed_in_at, row.server);
      const notice = this.#host.sql.exec("SELECT kind FROM mcp_notices WHERE server = ?", row.server).toArray()[0];
      if (notice?.kind === "needed") continue;
      const endsAt = row.signed_in_at + grant;
      this.#host.sql.exec(
        "INSERT INTO mcp_notices (server, kind, what, ends_at, at) VALUES (?, 'ending', NULL, ?, ?) ON CONFLICT(server) DO UPDATE SET kind = 'ending', ends_at = excluded.ends_at, at = excluded.at",
        row.server,
        endsAt,
        now,
      );
      await this.#tell({ type: "sign-in", server: row.server, kind: "ending", link: signInPath(row.server), endsAt, at: now });
    }
    const configs = new Map(this.#oauthServers().map((server) => [server.name, server]));
    for (const row of rows) {
      const config = configs.get(row.server);
      if (!config || row.keep_at > now) continue;
      const result = await this.#check(config);
      if (result === "needs_sign_in") await this.needed(row.server);
      else
        this.#host.sql.exec(
          "UPDATE mcp_auth SET keep_at = ? WHERE server = ?",
          this.#now() + (result === "ok" ? KEEP_ALIVE_MS : KEEP_ALIVE_RETRY_MS),
          row.server,
        );
    }
    this.#schedule();
  }

  /** Set the alarm for the next warning or keep-alive due, or clear it. */
  #schedule(): void {
    const grant = grantMs(this.#host.env);
    const runs = new Set(this.#runServers());
    let next = Infinity;
    for (const row of this.#rows()) {
      if (row.signed_in !== 1 || !runs.has(row.server)) continue;
      next = Math.min(next, row.keep_at);
      if (row.signed_in_at !== null && row.warned_at !== row.signed_in_at) next = Math.min(next, warnAt(row.signed_in_at, grant));
    }
    this.#host.setAlarm(Number.isFinite(next) ? Math.max(next, this.#now()) : null);
  }

  async #check(config: McpServerConfig): Promise<SignInCheck> {
    return (this.#host.check ?? checkSignIn)(config, this.store(config.name));
  }

  async #tell(notice: SignInNotice): Promise<void> {
    this.#host.changed();
    const { title, body } = signInNoticeText({ ...notice, what: undefined });
    await this.#host.notify(notice, { title, body, url: "/", tag: `sign-in:${notice.server}` });
  }

  #serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => {}).then(fn);
    this.#queue = next;
    return next;
  }

  async #read(server: string): Promise<McpAuthRecord> {
    const row = this.#host.sql.exec("SELECT data FROM mcp_auth WHERE server = ?", server).toArray()[0] as Pick<AuthRow, "data"> | undefined;
    if (!row) return {};
    const opened = await openAuthRecord(await this.#host.key(), server, row.data).catch((error: unknown) => {
      // Sealed under another key (MCP_TOKENS_KEY added or changed since): unreadable for good. Forget it, so the user
      // signs in again instead of every call failing.
      console.error(`sign-in record for ${server} does not open, forgetting it:`, errorMessage(error));
      return null;
    });
    if (!opened) {
      await this.#write(server, {}, {});
      return {};
    }
    if (opened.plain) await this.#write(server, opened.record, opened.record);
    return opened.record;
  }

  /** Write `record` sealed. New tokens (a sign-in or a refresh) put the next keep-alive a day off; no tokens end the grant. */
  async #write(server: string, before: McpAuthRecord, record: McpAuthRecord): Promise<void> {
    const sql = this.#host.sql;
    const signedIn = Boolean(record.tokens);
    if (Object.keys(record).length === 0) {
      sql.exec("DELETE FROM mcp_auth WHERE server = ?", server);
    } else {
      const data = await sealAuthRecord(await this.#host.key(), server, record);
      const now = this.#now();
      const fresh = signedIn && before.tokens?.access_token !== record.tokens?.access_token;
      sql.exec(
        `INSERT INTO mcp_auth (server, data, signed_in, signed_in_at, warned_at, keep_at) VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(server) DO UPDATE SET data = excluded.data, signed_in = excluded.signed_in,
           signed_in_at = CASE WHEN excluded.signed_in = 0 THEN NULL ELSE COALESCE(mcp_auth.signed_in_at, excluded.signed_in_at) END,
           warned_at = CASE WHEN excluded.signed_in = 0 THEN 0 ELSE mcp_auth.warned_at END,
           keep_at = CASE WHEN ? THEN excluded.keep_at ELSE mcp_auth.keep_at END`,
        server,
        data,
        signedIn ? 1 : 0,
        signedIn ? now : null,
        now + KEEP_ALIVE_MS,
        fresh ? 1 : 0,
      );
    }
    if (Boolean(before.tokens) !== signedIn) {
      this.#host.changed();
      this.#schedule();
    }
  }

  #rows(): AuthRow[] {
    return this.#host.sql.exec("SELECT server, data, signed_in, signed_in_at, warned_at, keep_at FROM mcp_auth").toArray() as AuthRow[];
  }

  #runServers(): string[] {
    return this.#host.sql
      .exec("SELECT DISTINCT server FROM mcp_run_servers")
      .toArray()
      .map((row) => row.server as string);
  }

  #oauthServers(): McpServerConfig[] {
    return mcpServers(this.#host.env).filter((server) => server.auth === "oauth");
  }
}
