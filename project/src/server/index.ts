import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { addClient, emit } from "./sse";
import { provideHelp, cancelPendingForRun } from "./help";
import { runOnce } from "../runner/runOnce";
import {
  createRunControl,
  getRunControl,
  requestStop,
  requestFinish,
  requestTerminate,
} from "./runControl";

console.log("OPENAI_API_KEY loaded?", Boolean(process.env.OPENAI_API_KEY));

const parsedPort = Number(process.env.PORT ?? 3000);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 3000;

const app = express();
app.use(cors());
app.use(express.json());

const RUNS_DIR = path.resolve(process.cwd(), "runs");
await fs.mkdir(RUNS_DIR, { recursive: true });

app.use("/runs", express.static(RUNS_DIR));

app.get("/health", (_req, res) => res.json({ ok: true }));

// TOTO SPUSTI NOVY BEH AGENTA
app.post("/api/runs", async (req, res) => {
  const url = String(req.body?.url ?? "");
  const task = String(req.body?.task ?? "");
  const maxSteps = Number(req.body?.maxSteps ?? 25);
  const allowHumanHelp = req.body?.allowHumanHelp !== false;
  const difficulty = typeof req.body?.difficulty === "string" ? req.body.difficulty.trim() : "";
  const runLabel = typeof req.body?.runLabel === "string" ? req.body.runLabel.trim() : "";

  if (!url) return res.status(400).json({ error: "Missing url" });
  if (!task) return res.status(400).json({ error: "Missing task" });

  const runId = crypto.randomUUID();

  createRunControl(runId);

  runOnce(runId, url, task, maxSteps, {
    allowHumanHelp,
    difficulty: difficulty || undefined,
    runLabel: runLabel || undefined,
  }).catch((e) => {
    emit({
      type: "run_finished",
      runId,
      ts: Date.now(),
      success: false,
      reason: String(e),
      error: String(e),
    });
  });

  res.json({ runId, allowHumanHelp });
});

// TOTO PRIJME ODPOVED OD POUZIVATELA NA POMOC
app.post("/api/runs/:id/help", (req, res) => {
  const runId = req.params.id;
  const helpId = String(req.body?.helpId ?? "");
  const text = String(req.body?.text ?? "").trim();

  if (!helpId) return res.status(400).json({ error: "Missing helpId" });
  if (!text) return res.status(400).json({ error: "Missing text" });

  provideHelp(runId, helpId, text);
  res.json({ ok: true });
});

// TOTO POZASTAVI BEZIACI BEH
app.post("/api/runs/:id/stop", (req, res) => {
  const runId = req.params.id;
  const control = requestStop(runId, "paused_by_user");

  if (!control) return res.status(404).json({ error: "Run not found" });

  cancelPendingForRun(runId, "paused_by_user");
  emit({
    type: "run_control",
    runId,
    ts: Date.now(),
    state: control.state,
    reason: control.reason,
  });
  emit({
    type: "log",
    runId,
    ts: Date.now(),
    message: "Run control: pause requested by user.",
  });

  res.json({ ok: true, state: control.state });
});

// TOTO RUCNE UKONCI BEH AKO USPESNY
app.post("/api/runs/:id/finish", (req, res) => {
  const runId = req.params.id;
  const control = requestFinish(runId, "finished_by_user");

  if (!control) return res.status(404).json({ error: "Run not found" });

  cancelPendingForRun(runId, "finished_by_user");
  emit({
    type: "run_control",
    runId,
    ts: Date.now(),
    state: control.state,
    reason: control.reason,
  });
  emit({
    type: "log",
    runId,
    ts: Date.now(),
    message: "Run control: manual finish requested by user.",
  });

  res.json({ ok: true, state: control.state });
});

// TOTO NASILNE UKONCI BEH AKO NEUSPESNY
app.post("/api/runs/:id/terminate", (req, res) => {
  const runId = req.params.id;
  const control = requestTerminate(runId, "terminated_by_user");

  if (!control) return res.status(404).json({ error: "Run not found" });

  cancelPendingForRun(runId, "terminated_by_user");
  emit({
    type: "run_control",
    runId,
    ts: Date.now(),
    state: control.state,
    reason: control.reason,
  });
  emit({
    type: "log",
    runId,
    ts: Date.now(),
    message: "Run control: terminate requested by user.",
  });

  res.json({ ok: true, state: control.state });
});

app.get("/api/runs/:id/state", (req, res) => {
  const runId = req.params.id;
  const control = getRunControl(runId);

  if (!control) return res.status(404).json({ error: "Run not found" });
  res.json(control);
});

// TOTO OTVORI SSE STREAM PRE KLIENTA
app.get("/api/runs/:id/events", (req, res) => {
  const runId = req.params.id;
  const lastEventIdRaw = req.header("last-event-id");
  const lastEventId = lastEventIdRaw ? Number(lastEventIdRaw) : null;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");

  const keepAlive = setInterval(() => {
    res.write(`: keepalive ${Date.now()}\n\n`);
  }, 10_000);

  res.on("close", () => {
    clearInterval(keepAlive);
  });

  addClient(runId, res, Number.isFinite(lastEventId) ? lastEventId : null);
});

const server = app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Another backend is already running on http://localhost:${PORT}. ` +
        `Stop the existing process or start this server with a different PORT.`
    );
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
