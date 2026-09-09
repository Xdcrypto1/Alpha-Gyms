import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import membersRouter from "./routes/members.js";
import startReminderJob from "./cron/reminderJob.js";
import authRouter from "./routes/auth.js";
import plansRouter from "./routes/plans.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
startReminderJob();

app.use("/api/members", membersRouter);
app.use("/api/auth", authRouter);
app.use("/api/plans", plansRouter);

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});