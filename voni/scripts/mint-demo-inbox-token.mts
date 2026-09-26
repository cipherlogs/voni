/**
 * One-time: mint DEMO_INBOX_REFRESH_TOKEN for the demo's shared test inbox
 * (see ENVIRONMENT.md "Demo test inbox"). Opens Google consent for the inbox
 * account on the app's OAuth client, catches the redirect on localhost, and
 * prints the refresh token. gmail.modify covers reading now and replying in
 * ticket 04, so the owner consents once.
 *
 *   node --env-file=.dev.vars --import tsx scripts/mint-demo-inbox-token.mts
 */
import { createServer } from "node:http";
import { DEMO_INBOX_ADDRESS } from "../src/lib/demo/email-test";

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}`;
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing (run with --env-file=.dev.vars)");

const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consent.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/gmail.modify",
  access_type: "offline",
  prompt: "consent",
  login_hint: DEMO_INBOX_ADDRESS,
}).toString();

console.log(`Sign in as the test inbox account:\n\n${consent}\n`);

const server = createServer(async (req, res) => {
  const code = new URL(req.url ?? "/", REDIRECT).searchParams.get("code");
  if (!code) return void res.end("No code in this request.");
  const token = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
  }).then((r) => r.json() as Promise<{ refresh_token?: string; error?: string }>);
  res.end(token.refresh_token ? "Done. Back to the terminal." : `Failed: ${token.error}`);
  console.log(token.refresh_token ? `DEMO_INBOX_REFRESH_TOKEN=${token.refresh_token}` : `Failed: ${JSON.stringify(token)}`);
  server.close();
});
server.listen(PORT);
