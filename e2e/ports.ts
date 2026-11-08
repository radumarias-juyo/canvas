/** Where the e2e suite runs the app. */
export const APP_PORT = Number(process.env.E2E_PORT ?? 5190);
/** The crm stand-in (e2e/stand-in.ts); vault, behind OAuth, listens on the next port. */
export const MCP_PORT = Number(process.env.E2E_MCP_PORT ?? 5191);
