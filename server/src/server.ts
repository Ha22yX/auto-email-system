import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import router from "./routes";
import { startProcessingWorker } from "./email/processor";
import { markInterruptedRuns, promoteFinancialRecordEmails } from "./store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT ?? 8787);

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use("/api", router);
app.use(express.static(distDir));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, () => {
  promoteFinancialRecordEmails();
  const interruptedCount = markInterruptedRuns();
  startProcessingWorker({ recoverInterruptedOnFirstRun: interruptedCount > 0 });
  console.log(`自动邮件系统已启动: http://127.0.0.1:${port}`);
});
