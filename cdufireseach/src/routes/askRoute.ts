import type { Express, Request, Response } from "express";
import type { CduQaService } from "../services/cduQaService.js";

type AskRequestBody = {
  question?: unknown;
  siteName?: unknown;
};

export function registerAskRoute(app: Express, qaService: CduQaService): void {
  app.post("/api/ask", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as AskRequestBody;
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const siteName =
      typeof body.siteName === "string" && body.siteName.trim()
        ? body.siteName.trim()
        : undefined;

    if (!question) {
      res.status(400).json({
        error: {
          code: "INVALID_QUESTION",
          message: "question is required and must be a non-empty string"
        }
      });
      return;
    }

    try {
      const result = await qaService.ask(question, siteName);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: {
          code: "ASK_FAILED",
          message: error instanceof Error ? error.message : "Internal server error"
        }
      });
    }
  });
}
