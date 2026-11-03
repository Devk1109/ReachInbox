import session from "express-session";
import { env } from "./env";
import { PrismaSessionStore } from "./session-store";

export const sessionMiddleware = session({
  name: "reachinbox.sid",
  secret: env.SESSION_SECRET,
  store: new PrismaSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
