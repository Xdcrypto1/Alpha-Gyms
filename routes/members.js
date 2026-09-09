import express from "express";
import pool from "../db/index.js";
import protect from "../middleware/auth.js";
import sendReminder from "../mailer/sendReminder.js";

const router = express.Router();

const PLAN_DURATIONS = {
  "Weekly": 7,
  "Monthly": 30,
  "Quarterly": 90,
  "Annual": 365,
};

// Get all members
router.get("/", protect, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM members WHERE gym_id = $1 ORDER BY expiry_date ASC",
      [req.gymId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch members" });
  }
});

// Add member manually
router.post("/", protect, async (req, res) => {
  const { name, email, plan, amount, payment_method, payment_reference, whatsapp } = req.body;

  if (!name || !plan) {
    return res.status(400).json({ error: "Name and plan are required" });
  }

  const durationDays = PLAN_DURATIONS[plan] || 30;
  const start_date = new Date();
  const expiry_date = new Date();
  expiry_date.setDate(expiry_date.getDate() + durationDays);

  try {
    const result = await pool.query(
      `INSERT INTO members 
        (name, email, plan, amount, start_date, expiry_date, payment_method, payment_reference, gym_id, whatsapp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        name, email, plan, amount, start_date, expiry_date,
        payment_method || "cash", payment_reference || null,
        req.gymId, whatsapp || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to add member" });
  }
});

// Update member status
router.patch("/:id", protect, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const result = await pool.query(
      "UPDATE members SET status = $1 WHERE id = $2 AND gym_id = $3 RETURNING *",
      [status, id, req.gymId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update member" });
  }
});

// Reactivate member — extends expiry based on plan
router.post("/:id/reactivate", protect, async (req, res) => {
  const { id } = req.params;
  const { plan, amount } = req.body;

  try {
    const memberResult = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND gym_id = $2",
      [id, req.gymId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    const member = memberResult.rows[0];

    // Use provided plan or fall back to member's existing plan
    const activePlan = plan || member.plan;
    const activeAmount = amount || member.amount;

    // Look up duration from plans table first, fallback to PLAN_DURATIONS
    const planResult = await pool.query(
      "SELECT * FROM plans WHERE gym_id = $1 AND name = $2",
      [req.gymId, activePlan]
    );

    let durationDays;
    if (planResult.rows.length > 0) {
      durationDays = planResult.rows[0].duration_days;
    } else {
      durationDays = PLAN_DURATIONS[activePlan] || 30;
    }

    const start_date = new Date();
    const expiry_date = new Date();
    expiry_date.setDate(expiry_date.getDate() + durationDays);

    const result = await pool.query(
      `UPDATE members 
       SET status = 'active', plan = $1, amount = $2, start_date = $3, expiry_date = $4, payment_method = 'renewal'
       WHERE id = $5 AND gym_id = $6
       RETURNING *`,
      [activePlan, activeAmount, start_date, expiry_date, id, req.gymId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to reactivate member" });
  }
});

// Delete member — requires delete code
router.delete("/:id", protect, async (req, res) => {
  const { id } = req.params;
  const { delete_code } = req.body;

  if (!delete_code) {
    return res.status(400).json({ error: "Delete code is required" });
  }

  if (delete_code !== process.env.DELETE_CODE) {
    return res.status(403).json({ error: "Incorrect delete code" });
  }

  try {
    await pool.query(
      "DELETE FROM members WHERE id = $1 AND gym_id = $2",
      [id, req.gymId]
    );
    res.json({ message: "Member deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete member" });
  }
});

// Stats
router.get("/stats", protect, async (req, res) => {
  try {
    const totalResult = await pool.query(
      "SELECT COUNT(*) FROM members WHERE gym_id = $1 AND status = 'active'",
      [req.gymId]
    );

    const expiringResult = await pool.query(
      `SELECT * FROM members 
       WHERE gym_id = $1 
       AND status = 'active'
       AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
       ORDER BY expiry_date ASC`,
      [req.gymId]
    );

    const revenueAtRiskResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM members 
       WHERE gym_id = $1 
       AND status = 'active'
       AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`,
      [req.gymId]
    );

    const revenueLostResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM members 
       WHERE gym_id = $1 
       AND status = 'expired'
       AND expiry_date >= CURRENT_DATE - INTERVAL '30 days'`,
      [req.gymId]
    );

    const expiredResult = await pool.query(
      `SELECT * FROM members
       WHERE gym_id = $1
       AND status = 'expired'
       ORDER BY expiry_date DESC`,
      [req.gymId]
    );

    const recoveredResult = await pool.query(
      `SELECT COUNT(*) FROM members 
       WHERE gym_id = $1 
       AND status = 'active'
       AND payment_method = 'renewal'`,
      [req.gymId]
    );

    const expiredCount = expiredResult.rows.length;
    const totalRecovered = parseInt(recoveredResult.rows[0].count);
    const recoveryRate = expiredCount > 0
      ? Math.round((totalRecovered / expiredCount) * 100)
      : 0;

    res.json({
      totalActive: parseInt(totalResult.rows[0].count),
      expiringThisWeek: expiringResult.rows,
      revenueAtRisk: parseInt(revenueAtRiskResult.rows[0].total),
      revenueLost: parseInt(revenueLostResult.rows[0].total),
      expiredMembers: expiredResult.rows,
      recoveryRate,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Send manual reminder
router.post("/:id/remind", protect, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND gym_id = $2",
      [req.params.id, req.gymId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    const member = result.rows[0];
    const expiry = new Date(member.expiry_date);
    const today = new Date();
    const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

    if (member.whatsapp) {
      const number = member.whatsapp.replace(/^0/, "234").replace(/\D/g, "");
      const message = encodeURIComponent(
        `Hi ${member.name} 👋, your *${member.plan}* membership at our gym expires in *${daysLeft} day${daysLeft !== 1 ? "s" : ""}*. Renew now to keep your access 💪`
      );
      return res.json({ whatsappUrl: `https://wa.me/${number}?text=${message}` });
    }

    await sendReminder({
      name: member.name,
      email: member.email,
      plan: member.plan,
      expiry_date: member.expiry_date,
      daysLeft,
    });

    res.json({ message: "Reminder sent via email" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to send reminder" });
  }
});

// Remind all expiring this week
router.post("/remind-all", protect, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM members 
       WHERE gym_id = $1 
       AND status = 'active'
       AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`,
      [req.gymId]
    );

    const members = result.rows;
    const whatsappLinks = [];

    for (const member of members) {
      const expiry = new Date(member.expiry_date);
      const today = new Date();
      const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

      if (member.whatsapp) {
        const number = member.whatsapp.replace(/^0/, "234").replace(/\D/g, "");
        const message = encodeURIComponent(
          `Hi ${member.name} 👋, your *${member.plan}* membership expires in *${daysLeft} day${daysLeft !== 1 ? "s" : ""}*. Renew now to keep your access 💪`
        );
        whatsappLinks.push({
          name: member.name,
          url: `https://wa.me/${number}?text=${message}`,
        });
      } else {
        await sendReminder({
          name: member.name,
          email: member.email,
          plan: member.plan,
          expiry_date: member.expiry_date,
          daysLeft,
        });
      }
    }

    res.json({
      message: `Processed ${members.length} members`,
      whatsappLinks,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to send reminders" });
  }
});

export default router;
