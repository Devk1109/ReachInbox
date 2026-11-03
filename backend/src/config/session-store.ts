import session, { type SessionData } from "express-session";
import { Prisma } from "@prisma/client";
import { prisma } from "./database";

export class PrismaSessionStore extends session.Store {
  get(sid: string, callback: (error: unknown, session?: SessionData | null) => void): void {
    void prisma.session.findUnique({ where: { sid } }).then(async (record) => {
      if (!record) {
        callback(null, null);
        return;
      }
      if (record.expiresAt <= new Date()) {
        await prisma.session.delete({ where: { sid } });
        callback(null, null);
        return;
      }
      callback(null, record.data as unknown as SessionData);
    }).catch((error: unknown) => callback(error));
  }

  set(sid: string, value: SessionData, callback?: (error?: unknown) => void): void {
    const expiresAt = value.cookie.expires
      ? new Date(value.cookie.expires)
      : new Date(Date.now() + (value.cookie.maxAge ?? 86_400_000));
    const data = JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

    void prisma.session.upsert({
      where: { sid },
      create: { sid, data, expiresAt },
      update: { data, expiresAt },
    }).then(() => callback?.()).catch((error: unknown) => callback?.(error));
  }

  destroy(sid: string, callback?: (error?: unknown) => void): void {
    void prisma.session.deleteMany({ where: { sid } })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  touch(sid: string, value: SessionData, callback?: (error?: unknown) => void): void {
    const expiresAt = value.cookie.expires
      ? new Date(value.cookie.expires)
      : new Date(Date.now() + (value.cookie.maxAge ?? 86_400_000));
    void prisma.session.updateMany({ where: { sid }, data: { expiresAt } })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }
}
