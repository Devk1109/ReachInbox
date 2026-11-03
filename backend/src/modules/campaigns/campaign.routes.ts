import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/auth.middleware";
import { CampaignService, EmptyRecipientListError, InvalidRecipientListError, SenderUnavailableError, type CampaignService as CampaignServiceType } from "./campaign.service";
import { RecipientFileError } from "./recipient-parser";

const csvSchema = z.object({ recipientCsv: z.string().max(2 * 1024 * 1024) });

const createCampaignSchema = z.object({
  senderId: z.uuid(),
  subject: z.string().trim().min(1).max(255),
  body: z.string().min(1).max(200_000),
  startTime: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  delayBetweenEmails: z.number().int().min(0).max(86_400),
  hourlyLimit: z.number().int().min(1).max(100_000),
  recipientCsv: z.string().max(2 * 1024 * 1024),
});

export function createCampaignRouter(
  service: CampaignServiceType = new CampaignService(),
  ensureAuthenticated: RequestHandler = requireAuth(),
): Router {
  const router = Router();
  router.use(ensureAuthenticated);

  router.post("/validate-recipients", (request, response) => {
    const parsed = csvSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Provide a recipient CSV or text file under 2 MB" } });
      return;
    }
    try {
      const result = service.parseRecipients(parsed.data.recipientCsv);
      response.json({
        ...result,
        validCount: result.recipients.length,
        invalidCount: result.invalidRecipients.length,
        duplicateCount: result.duplicates.length,
      });
    } catch (error) {
      if (error instanceof RecipientFileError) {
        response.status(400).json({ error: { code: "INVALID_RECIPIENT_FILE", message: error.message } });
        return;
      }
      response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unable to read recipient file" } });
    }
  });

  router.post("/", async (request, response, next) => {
    const parsed = createCampaignSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid campaign details", details: parsed.error.issues } });
      return;
    }
    const { recipientCsv, ...input } = parsed.data;
    try {
      const result = await service.create(request.auth!.userId, input, recipientCsv);
      response.status(201).json({
        campaign: result.campaign,
        recipientCount: result.recipientResult.recipients.length,
        duplicateCount: result.recipientResult.duplicates.length,
      });
    } catch (error) {
      if (error instanceof InvalidRecipientListError) {
        response.status(422).json({
          error: { code: "INVALID_RECIPIENTS", message: error.message },
          validCount: error.result.recipients.length,
          invalidRecipients: error.result.invalidRecipients,
          duplicates: error.result.duplicates,
        });
        return;
      }
      if (error instanceof EmptyRecipientListError) {
        response.status(422).json({ error: { code: "EMPTY_RECIPIENT_LIST", message: error.message } });
        return;
      }
      if (error instanceof RecipientFileError) {
        response.status(400).json({ error: { code: "INVALID_RECIPIENT_FILE", message: error.message } });
        return;
      }
      if (error instanceof SenderUnavailableError) {
        response.status(404).json({ error: { code: "SENDER_NOT_FOUND", message: "Active sender not found" } });
        return;
      }
      next(error);
    }
  });

  router.get("/", async (request, response, next) => {
    try {
      response.json({ campaigns: await service.list(request.auth!.userId) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (request, response, next) => {
    try {
      const campaign = await service.find(request.auth!.userId, request.params.id!);
      if (!campaign) {
        response.status(404).json({ error: { code: "CAMPAIGN_NOT_FOUND", message: "Campaign not found" } });
        return;
      }
      response.json({ campaign });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/cancel", async (request, response, next) => {
    try {
      const campaign = await service.cancel(request.auth!.userId, request.params.id!);
      if (!campaign) {
        response.status(404).json({ error: { code: "CAMPAIGN_NOT_FOUND", message: "Campaign not found" } });
        return;
      }
      response.json({ campaign });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const campaignRouter = createCampaignRouter();
