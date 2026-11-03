import { z } from "zod";
import { env } from "../../config/env";

export interface SlackIdentity {
  accessToken: string;
  teamId: string;
  slackUserId: string;
}

const oauthResponseSchema = z.object({
  ok: z.boolean(),
  access_token: z.string().optional(),
  team: z.object({ id: z.string() }).optional(),
  authed_user: z.object({ id: z.string() }).optional(),
  error: z.string().optional(),
});

export class SlackOAuthService {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  createAuthorizationUrl(state: string): string {
    if (!env.SLACK_CLIENT_ID) throw new Error("Slack OAuth is not configured");
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", env.SLACK_CLIENT_ID);
    url.searchParams.set("scope", "chat:write,im:write");
    url.searchParams.set("redirect_uri", env.SLACK_CALLBACK_URL);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<SlackIdentity> {
    if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) throw new Error("Slack OAuth is not configured");
    const form = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: env.SLACK_CALLBACK_URL,
    });
    const response = await this.fetcher("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) throw new Error(`Slack OAuth failed with HTTP ${response.status}`);
    const parsed = oauthResponseSchema.parse(await response.json());
    if (!parsed.ok || !parsed.access_token || !parsed.team?.id || !parsed.authed_user?.id) {
      throw new Error(`Slack OAuth did not return a usable installation${parsed.error ? `: ${parsed.error}` : ""}`);
    }
    return { accessToken: parsed.access_token, teamId: parsed.team.id, slackUserId: parsed.authed_user.id };
  }
}
