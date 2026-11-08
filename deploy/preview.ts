// Where a deploy goes: production, as cloudflare.config.ts names it, or a preview, a separate Worker with its own
// resources, asked for through the environment (docs/preview-deploy.md). Production is what you get when nothing asks
// for a preview; a preview never reuses anything production keeps data in, and the config refuses one that would.

/** What cloudflare.config.ts takes from the deploy target. Rate-limit namespaces are per account, so a preview has its own. */
export type DeployTarget = {
  preview: boolean;
  name: string;
  /** Custom domains; none serves the Worker on workers.dev. */
  domains: string[];
  workersDev: boolean;
  accessTeamDomain: string;
  accessAud: string;
  bucket: string;
  repos: string;
  gateway: string;
  metrics: string;
  container: string;
  rateLimits: RateLimits;
};

export type RateLimits = { PAGE_CALLS: string; PAGE_AI: string; DICTATION: string; AGENT_TURNS: string };

/** What the environment says of a preview, if anything. */
export type PreviewEnv = {
  /** The preview Worker's name, which also names its bucket, Artifacts namespace, AI Gateway, dataset and container. */
  PI_PREVIEW?: string;
  /** A custom domain for it (a hostname on a zone in the account); without one it is served on workers.dev. */
  PI_PREVIEW_DOMAIN?: string;
  /** The audience tag of the Access application in front of the preview's hostname. Required. */
  PI_PREVIEW_ACCESS_AUD?: string;
  /** The Access team domain, if not production's. */
  PI_PREVIEW_ACCESS_TEAM_DOMAIN?: string;
  /** Another AI Gateway than the one named after the preview, such as production's, for its provider keys. */
  PI_PREVIEW_AI_GATEWAY?: string;
  /** Added to each of production's rate-limit namespaces (default 100). */
  PI_PREVIEW_RATE_LIMIT_OFFSET?: string;
  // Local development only; a preview refuses them.
  AUTH_MODE?: string;
  DEV_TOOLS?: string;
  DEV_MODEL?: string;
  DEV_PAUSE_MS?: string;
  PI_OFFLINE?: string;
};

/** A Worker name that leaves room for "-sandbox" and fits an R2 bucket's rules too: lowercase letters, digits, dashes. */
const NAME = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DEFAULT_OFFSET = 100;

/** Production, or the preview the environment asks for. Throws on a preview that is incomplete or would touch production. */
export function deployTarget(production: DeployTarget, env: PreviewEnv): DeployTarget {
  const name = env.PI_PREVIEW?.trim();
  if (!name) return production;
  const refuse = (why: string): never => {
    throw new Error(`Preview deploy (PI_PREVIEW=${name}): ${why}. See docs/preview-deploy.md.`);
  };
  if (!NAME.test(name)) refuse("the name takes 3 to 48 lowercase letters, digits and dashes, starting and ending with a letter or digit");
  if (name === production.name) refuse("the name is production's");
  for (const flag of ["AUTH_MODE", "DEV_TOOLS", "DEV_MODEL", "DEV_PAUSE_MS", "PI_OFFLINE"] as const) {
    if (env[flag]) refuse(`${flag} is for local development; unset it`);
  }
  const accessAud = env.PI_PREVIEW_ACCESS_AUD?.trim();
  if (!accessAud) refuse("PI_PREVIEW_ACCESS_AUD is missing: the preview serves only behind its own Access application");
  if (accessAud === production.accessAud) refuse("PI_PREVIEW_ACCESS_AUD is production's Access application");
  const domain = env.PI_PREVIEW_DOMAIN?.trim().toLowerCase();
  if (domain && !HOST.test(domain)) refuse(`PI_PREVIEW_DOMAIN "${domain}" is not a hostname`);
  if (domain && production.domains.includes(domain)) refuse("PI_PREVIEW_DOMAIN is production's");
  const offsetText = env.PI_PREVIEW_RATE_LIMIT_OFFSET?.trim();
  const offset = offsetText ? Number(offsetText) : DEFAULT_OFFSET;
  if (!Number.isSafeInteger(offset) || offset < 1) refuse("PI_PREVIEW_RATE_LIMIT_OFFSET takes a whole number of 1 or more");
  const taken = new Set(Object.values(production.rateLimits));
  const rateLimits = Object.fromEntries(
    Object.entries(production.rateLimits).map(([binding, namespace]) => {
      const moved = String(Number(namespace) + offset);
      if (taken.has(moved)) refuse(`rate-limit namespace ${moved} for ${binding} is production's; pick another PI_PREVIEW_RATE_LIMIT_OFFSET`);
      return [binding, moved];
    }),
  ) as RateLimits;
  const target: DeployTarget = {
    preview: true,
    name,
    domains: domain ? [domain] : [],
    workersDev: !domain,
    accessTeamDomain: env.PI_PREVIEW_ACCESS_TEAM_DOMAIN?.trim() || production.accessTeamDomain,
    accessAud: accessAud!,
    bucket: name,
    repos: name,
    gateway: env.PI_PREVIEW_AI_GATEWAY?.trim() || name,
    metrics: `${name.replaceAll("-", "_")}_metrics`,
    container: `${name}-sandbox`,
    rateLimits,
  };
  // What keeps the app's data: never production's. The gateway may be shared on purpose, for its provider keys; the
  // preview's requests then show in its logs.
  for (const key of ["bucket", "repos", "metrics", "container"] as const) {
    if (target[key] === production[key]) refuse(`its ${key} would be production's`);
  }
  return target;
}
