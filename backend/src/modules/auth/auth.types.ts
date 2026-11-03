import type { User } from "@prisma/client";

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  avatar?: string;
}

export type PublicUser = Pick<User, "id" | "name" | "email" | "avatar" | "createdAt">;

declare module "express-session" {
  interface SessionData {
    userId?: string;
    oauthState?: string;
    slackOAuthState?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string };
    }
  }
}
