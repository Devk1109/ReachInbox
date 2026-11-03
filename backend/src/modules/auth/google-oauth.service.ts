import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env";
import type { GoogleProfile } from "./auth.types";

export class GoogleOAuthService {
  private readonly client: OAuth2Client | undefined;

  constructor() {
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      this.client = new OAuth2Client(
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        env.GOOGLE_CALLBACK_URL,
      );
    }
  }

  createAuthorizationUrl(state: string): string {
    const client = this.getClient();
    return client.generateAuthUrl({
      access_type: "online",
      prompt: "select_account",
      scope: ["openid", "email", "profile"],
      state,
    });
  }

  async authenticateCode(code: string): Promise<GoogleProfile> {
    const client = this.getClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token || !env.GOOGLE_CLIENT_ID) {
      throw new Error("Google did not return an identity token");
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new Error("Google account has no verified email identity");
    }

    return {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      avatar: payload.picture,
    };
  }

  private getClient(): OAuth2Client {
    if (!this.client) {
      throw new Error("Google OAuth is not configured");
    }
    return this.client;
  }
}
