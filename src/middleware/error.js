
import { logger } from "../logger.js";

export function errorHandler(err, req, res, next) {
  logger.error({ err, path: req.path, body: req.body }, "Unhandled error");
  if (res.headersSent) return;
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || "Internal Server Error",
    code: err.code || undefined,
  });
}
