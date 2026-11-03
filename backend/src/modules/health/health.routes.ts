import { Router } from "express";
import { prisma } from "../../config/database";

export function createHealthRouter(checkDatabase: () => Promise<unknown> = () => prisma.$queryRaw`SELECT 1`): Router {
  const router = Router();

  router.get("/", async (_request, response) => {
    try {
      await checkDatabase();
      response.status(200).json({ status: "ok", checks: { database: "ok" } });
    } catch {
      response.status(503).json({ status: "unavailable", checks: { database: "error" } });
    }
  });

  return router;
}

export const healthRouter = createHealthRouter();
