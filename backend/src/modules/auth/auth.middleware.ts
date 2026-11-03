import type { RequestHandler } from "express";
import { prisma } from "../../config/database";

export function requireAuth(
  findUser: (userId: string) => Promise<{ id: string } | null> = (userId) =>
    prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
): RequestHandler {
  return async (request, response, next) => {
    const userId = request.session.userId;
    if (!userId) {
      response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } });
      return;
    }

    try {
      const user = await findUser(userId);
      if (!user) {
        request.session.destroy(() => undefined);
        response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } });
        return;
      }
      request.auth = { userId: user.id };
      next();
    } catch (error) {
      next(error);
    }
  };
}
