import express, { type Request, type Response, type NextFunction } from "express";
import { selectBackend } from "./backends";
import { CredentialService } from "./service";
import { HttpError } from "./types";

const app = express();
app.use(express.json());

const service = new CredentialService(selectBackend());

// orgId is always a path param and strictly validated — never crosses orgs.
const ORG_RE = /^[a-zA-Z0-9_-]{1,64}$/;

app.get("/health", (_req, res) => res.json({ ok: true, backend: selectBackend().name }));

app.post("/v1/credentials", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, provider, apiKey, meta } = req.body ?? {};
    if (!orgId || !provider || !apiKey)
      throw new HttpError(400, "orgId, provider, apiKey required");
    if (!ORG_RE.test(orgId)) throw new HttpError(400, "invalid orgId");
    res.status(201).json(await service.store(orgId, provider, apiKey, meta));
  } catch (e) {
    next(e);
  }
});

app.get("/v1/credentials/:orgId/:provider", async (req, res, next) => {
  try {
    const { orgId, provider } = req.params;
    if (!ORG_RE.test(orgId)) throw new HttpError(400, "invalid orgId");
    res.json(await service.getActive(orgId, provider));
  } catch (e) {
    next(e);
  }
});

app.get("/v1/credentials/:orgId/:provider/versions", async (req, res, next) => {
  try {
    const { orgId, provider } = req.params;
    if (!ORG_RE.test(orgId)) throw new HttpError(400, "invalid orgId");
    res.json(await service.listVersions(orgId, provider));
  } catch (e) {
    next(e);
  }
});

app.post("/v1/credentials/:orgId/:provider/rotate", async (req, res, next) => {
  try {
    const { orgId, provider } = req.params;
    const { apiKey, meta } = req.body ?? {};
    if (!apiKey) throw new HttpError(400, "apiKey required");
    if (!ORG_RE.test(orgId)) throw new HttpError(400, "invalid orgId");
    res.json(await service.rotate(orgId, provider, apiKey, meta));
  } catch (e) {
    next(e);
  }
});

app.post("/v1/credentials/:orgId/rotate-root", async (req, res, next) => {
  try {
    const { orgId } = req.params;
    if (!ORG_RE.test(orgId)) throw new HttpError(400, "invalid orgId");
    await service.rotateRoot(orgId);
    res.json({ ok: true, orgId });
  } catch (e) {
    next(e);
  }
});

app.delete("/v1/credentials/:orgId/:provider", async (req, res, next) => {
  try {
    const { orgId, provider } = req.params;
    if (!ORG_RE.test(orgId)) throw new HttpError(400, "invalid orgId");
    await service.delete(orgId, provider);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError)
    return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

export { app };
