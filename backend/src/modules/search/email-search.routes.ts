import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/auth.middleware";
import { EmailSearchService, type EmailSearchService as EmailSearchServiceType } from "./email-search.service";

const querySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  recipient: z.string().trim().email().optional(),
  subject: z.string().trim().min(1).max(255).optional(),
  campaignId: z.uuid().optional(),
  senderId: z.uuid().optional(),
  status: z.enum(["SCHEDULED", "PROCESSING", "SENT", "FAILED", "DELIVERY_UNKNOWN", "CANCELLED"]).optional(),
  scheduledFrom: z.iso.datetime({ offset: true }).optional(),
  scheduledTo: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).refine((query) => !query.scheduledFrom || !query.scheduledTo || query.scheduledFrom <= query.scheduledTo, {
  message: "scheduledFrom must be before scheduledTo",
});

export function createEmailSearchRouter(
  service: EmailSearchServiceType = new EmailSearchService(),
  ensureAuthenticated: RequestHandler = requireAuth(),
): Router {
  const router = Router();
  router.use(ensureAuthenticated);

  router.get("/", async (request, response, next) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid email search filters", details: parsed.error.issues } });
      return;
    }
    const { page, pageSize, ...filters } = parsed.data;
    try {
      const result = await service.search(request.auth!.userId, filters, page, pageSize);
      response.json({ ...result, page, pageSize });
    } catch (error) {
      console.error("Email search unavailable", error);
      response.status(503).json({ error: { code: "SEARCH_UNAVAILABLE", message: "Email search is temporarily unavailable" } });
    }
  });

  return router;
}

export const emailSearchRouter = createEmailSearchRouter();
