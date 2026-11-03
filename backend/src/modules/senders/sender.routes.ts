import { Prisma } from "@prisma/client";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/auth.middleware";
import { EtherealSenderNotConfiguredError, SenderService, type SenderService as SenderServiceType } from "./sender.service";

const createSenderSchema = z.object({
  email: z.string().trim().email().max(320),
  smtpHost: z.string().trim().min(1).max(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpUsername: z.string().trim().min(1).max(320),
  smtpPassword: z.string().min(1).max(4096),
  hourlyLimit: z.number().int().min(1).max(100_000),
  minDelaySeconds: z.number().int().min(0).max(86_400),
  isActive: z.boolean().optional(),
});

const updateSenderSchema = createSenderSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "Provide at least one sender field to update",
});

const etherealSenderSchema = z.object({
  email: z.string().trim().email().max(320),
  hourlyLimit: z.number().int().min(1).max(100_000),
  minDelaySeconds: z.number().int().min(0).max(86_400),
});

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

export function createSenderRouter(
  service: SenderServiceType = new SenderService(),
  ensureAuthenticated: RequestHandler = requireAuth(),
): Router {
  const router = Router();
  router.use(ensureAuthenticated);

  router.get("/", async (request, response, next) => {
    try {
      response.json({ senders: await service.list(request.auth!.userId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (request, response, next) => {
    const parsed = createSenderSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid sender details", details: parsed.error.issues } });
      return;
    }
    try {
      const sender = await service.create(request.auth!.userId, parsed.data);
      response.status(201).json({ sender });
    } catch (error) {
      if (isPrismaError(error, "P2002")) {
        response.status(409).json({ error: { code: "SENDER_EXISTS", message: "A sender with this email already exists" } });
        return;
      }
      next(error);
    }
  });

  router.post("/ethereal", async (request, response, next) => {
    const parsed = etherealSenderSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid Ethereal sender details" } });
      return;
    }
    try {
      const sender = await service.createEthereal(request.auth!.userId, parsed.data);
      response.status(201).json({ sender });
    } catch (error) {
      if (error instanceof EtherealSenderNotConfiguredError) {
        response.status(503).json({ error: { code: "ETHEREAL_NOT_CONFIGURED", message: error.message } });
        return;
      }
      if (isPrismaError(error, "P2002")) {
        response.status(409).json({ error: { code: "SENDER_EXISTS", message: "A sender with this email already exists" } });
        return;
      }
      next(error);
    }
  });

  router.put("/:id", async (request, response, next) => {
    const parsed = updateSenderSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid sender update", details: parsed.error.issues } });
      return;
    }
    try {
      const sender = await service.update(request.auth!.userId, request.params.id!, parsed.data);
      if (!sender) {
        response.status(404).json({ error: { code: "SENDER_NOT_FOUND", message: "Sender not found" } });
        return;
      }
      response.json({ sender });
    } catch (error) {
      if (isPrismaError(error, "P2002")) {
        response.status(409).json({ error: { code: "SENDER_EXISTS", message: "A sender with this email already exists" } });
        return;
      }
      next(error);
    }
  });

  router.delete("/:id", async (request, response, next) => {
    try {
      const deleted = await service.delete(request.auth!.userId, request.params.id!);
      if (!deleted) {
        response.status(404).json({ error: { code: "SENDER_NOT_FOUND", message: "Sender not found" } });
        return;
      }
      response.status(204).end();
    } catch (error) {
      if (isPrismaError(error, "P2003")) {
        response.status(409).json({ error: { code: "SENDER_IN_USE", message: "Sender is referenced by campaign history and cannot be removed" } });
        return;
      }
      next(error);
    }
  });

  return router;
}

export const senderRouter = createSenderRouter();
