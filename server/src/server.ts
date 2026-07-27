import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import router from "./routes";
import { startProcessingWorker } from "./email/processor";
import { startImapIdleWatchers } from "./email/imap-idle";
import { retryPendingEmailNotifications, startPendingNotificationRetryWorker } from "./notifications/pending";
import { setWeclawContextReadyHandler, startStoredWeclawBridges } from "./weclaw/manager";
import { runAsUser } from "./user-context";
import { apiRateLimit, corsOrigin, csrfProtection, securityHeaders } from "./security";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(process.env.APP_ROOT ?? process.cwd());
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT ?? 8787);

setWeclawContextReadyHandler(async (userId) => {
  await runAsUser(userId, () => retryPendingEmailNotifications());
});

const app = express();

app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(cors({ origin: corsOrigin, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "10mb", strict: true }));
app.use("/api", apiRateLimit, csrfProtection);
app.use("/api", router);
app.use(
  express.static(distDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-store");
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    }
  })
);
app.get(/.*/, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, () => {
  startProcessingWorker({ recoverInterruptedOnFirstRun: true });
  startImapIdleWatchers();
  startPendingNotificationRetryWorker();
  void startStoredWeclawBridges();
  console.log(`自动邮件系统已启动: http://127.0.0.1:${port}`);
});
