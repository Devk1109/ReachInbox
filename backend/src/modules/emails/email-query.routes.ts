import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/auth.middleware";
import { EmailQueryService, type EmailMailboxStateUpdate, type EmailQueryService as EmailQueryServiceType, type EmailStatusGroup } from "./email-query.service";
import { EmailSearchService } from "../search/email-search.service";

type EmailQueryServicePort = Pick<EmailQueryServiceType, "list" | "find" | "updateMailboxState">;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function createEmailQueryRouter(
  service: EmailQueryServicePort = new EmailQueryService(),
  ensureAuthenticated: RequestHandler = requireAuth(),
  reindexEmail: (emailId: string) => Promise<void> = (emailId) => new EmailSearchService().indexEmail(emailId),
): Router {
  const router = Router();
  router.use(ensureAuthenticated);

  async function updateMailboxState(request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2], data: EmailMailboxStateUpdate) {
    try {
      const routeId = request.params.id;
      const emailId = Array.isArray(routeId) ? routeId[0] : routeId;
      if (!emailId) {
        response.status(404).json({ error: { code: "EMAIL_NOT_FOUND", message: "Email not found" } });
        return;
      }
      const email = await service.updateMailboxState(request.auth!.userId, emailId, data);
      if (!email) {
        response.status(404).json({ error: { code: "EMAIL_NOT_FOUND", message: "Email not found" } });
        return;
      }
      void reindexEmail(email.id).catch((error: unknown) => console.error("Unable to refresh email search document", error));
      response.json({ email });
    } catch (error) {
      next(error);
    }
  }

  const addListRoute = (path: string, group: EmailStatusGroup) => {
    router.get(path, async (request, response, next) => {
      const parsed = paginationSchema.safeParse(request.query);
      if (!parsed.success) {
        response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid pagination values" } });
        return;
      }
      try {
        const { page, pageSize } = parsed.data;
        const result = await service.list(request.auth!.userId, group, page, pageSize);
        response.json({ ...result, page, pageSize });
      } catch (error) {
        next(error);
      }
    });
  };

  addListRoute("/scheduled", "scheduled");
  addListRoute("/sent", "sent");
  addListRoute("/failed", "failed");
  addListRoute("/unknown", "unknown");

  router.patch("/:id/star", (request, response, next) => {
    const parsed = z.object({ isStarred: z.boolean() }).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Provide a star state" } });
      return;
    }
    void updateMailboxState(request, response, next, { isStarred: parsed.data.isStarred });
  });

  router.post("/:id/archive", (request, response, next) => {
    void updateMailboxState(request, response, next, { archivedAt: new Date(), trashedAt: null });
  });

  router.post("/:id/trash", (request, response, next) => {
    void updateMailboxState(request, response, next, { trashedAt: new Date(), archivedAt: null });
  });

  router.post("/:id/restore", (request, response, next) => {
    void updateMailboxState(request, response, next, { archivedAt: null, trashedAt: null });
  });

  router.get("/:id", async (request, response, next) => {
    try {
      const email = await service.find(request.auth!.userId, request.params.id!);
      if (!email) {
        response.status(404).json({ error: { code: "EMAIL_NOT_FOUND", message: "Email not found" } });
        return;
      }
      response.json({ email });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const emailQueryRouter = createEmailQueryRouter();
