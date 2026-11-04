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

// Membership dates are calendar dates, not timestamps. Keep all calculations
// in YYYY-MM-DD form so server/UTC timezone conversions cannot shift a day.
const getLagosDateOnly = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const isValidDateOnly = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const addDaysToDateOnly = (dateOnly, days) => {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
};

// Monthly memberships last (days in their start month - 1) days.
// Other plans retain the duration configured for that gym's plan.
const calculateExpiryDate = (startDate, planName, configuredDuration) => {
  let durationDays;

  if (planName === "Monthly") {
    const [year, month] = startDate.split("-").map(Number);
    durationDays = new Date(Date.UTC(year, month, 0)).getUTCDate() - 1;
  } else {
    durationDays = Number(configuredDuration) || 30;
  }

  return addDaysToDateOnly(startDate, durationDays);
};

// Get all members
router.get("/", protect, async (req, res) => {
  try {
    // Keep membership status accurate even if the daily cron has not run yet.
    await pool.query(
      `UPDATE members
       SET status = 'expired'
       WHERE gym_id = $1
       AND status = 'active'
       AND expiry_date < CURRENT_DATE`,
      [req.gymId]
    );

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
  const {
    name,
    email,
    plan,
    amount,
    payment_method,
    payment_reference,
    whatsapp,
    sex,
    date_of_birth,
    start_date,
  } = req.body;

  if (!name || !plan) {
    return res.status(400).json({ error: "Name and plan are required" });
  }

  const membershipStartDate = start_date || getLagosDateOnly();

  if (!isValidDateOnly(membershipStartDate)) {
    return res.status(400).json({ error: "Invalid membership start date" });
  }

  if (date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
    return res.status(400).json({ error: "Invalid birthday" });
  }

  try {
    // Read the actual duration from this gym's plan instead of relying on hard-coded
    // plan names. This also makes custom plans work correctly.
    const planResult = await pool.query(
      "SELECT duration_days, amount FROM plans WHERE gym_id = $1 AND name = $2",
      [req.gymId, plan]
    );

    if (planResult.rows.length === 0) {
      return res.status(400).json({
        error: "Selected membership plan was not found",
      });
    }

    const expiryDate = calculateExpiryDate(
      membershipStartDate,
      plan,
      planResult.rows[0].duration_days
    );

    const memberAmount = amount ?? planResult.rows[0].amount;

    const result = await pool.query(
      `INSERT INTO members
        (name, email, plan, amount, start_date, expiry_date, payment_method, payment_reference, gym_id, whatsapp, sex, date_of_birth)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        name.trim(),
        email || null,
        plan,
        memberAmount,
        membershipStartDate,
        expiryDate,
        "transfer",
        payment_reference || null,
        req.gymId,
        whatsapp || null,
        sex || null,
        date_of_birth || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to add member" });
  }
});

// Edit safe member profile fields only. Membership/financial fields are intentionally excluded.
router.put("/:id/profile", protect, async (req, res) => {
  const { id } = req.params;
  const { name, email, whatsapp, sex, date_of_birth } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }

  if (date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
    return res.status(400).json({ error: "Invalid birthday" });
  }

  try {
    const result = await pool.query(
      `UPDATE members
       SET name = $1,
           email = $2,
           whatsapp = $3,
           sex = $4,
           date_of_birth = $5::date
       WHERE id = $6 AND gym_id = $7
       RETURNING *`,
      [
        name.trim(),
        email?.trim() || null,
        whatsapp?.trim() || null,
        sex || null,
        date_of_birth || null,
        id,
        req.gymId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to update member information",
    });
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

    const start_date = getLagosDateOnly();
    const configuredDuration =
      planResult.rows.length > 0
        ? planResult.rows[0].duration_days
        : PLAN_DURATIONS[activePlan] || 30;
    const expiry_date = calculateExpiryDate(
      start_date,
      activePlan,
      configuredDuration
    );

    const result = await pool.query(
      `UPDATE members 
       SET status = 'active',
           plan = $1,
           amount = $2,
           start_date = $3::date,
           expiry_date = $4::date,
           payment_method = 'renewal'
       WHERE id = $5 AND gym_id = $6
       RETURNING *`,
      [
        activePlan,
        activeAmount,
        start_date,
        expiry_date,
        id,
        req.gymId,
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to reactivate member",
    });
  }
});

// Delete member — requires delete code
router.delete("/:id", protect, async (req, res) => {
  const { id } = req.params;
  const { delete_code } = req.body;

  if (!delete_code) {
    return res.status(400).json({
      error: "Delete code is required",
    });
  }

  if (delete_code !== process.env.DELETE_CODE) {
    return res.status(403).json({
      error: "Incorrect delete code",
    });
  }

  try {
    await pool.query(
      "DELETE FROM members WHERE id = $1 AND gym_id = $2",
      [id, req.gymId]
    );

    res.json({ message: "Member deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to delete member",
    });
  }
});

// Stats
router.get("/stats", protect, async (req, res) => {
  try {
    // Keep status in sync even if the daily cron has not run yet.
    // This prevents expired members from remaining in the active list.
    await pool.query(
      `UPDATE members
       SET status = 'expired'
       WHERE gym_id = $1
       AND status = 'active'
       AND expiry_date < CURRENT_DATE`,
      [req.gymId]
    );

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

    const recoveryRate =
      expiredCount > 0
        ? Math.round((totalRecovered / expiredCount) * 100)
        : 0;

    res.json({
      totalActive: parseInt(totalResult.rows[0].count),
      expiringThisWeek: expiringResult.rows,
      revenueAtRisk: parseInt(revenueAtRiskResult.rows[0].total),
      expiredMembers: expiredResult.rows,
      recoveryRate,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to fetch stats",
    });
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
      return res.status(404).json({
        error: "Member not found",
      });
    }

    const member = result.rows[0];
    const expiry = new Date(member.expiry_date);
    const today = new Date();

    const daysLeft = Math.ceil(
      (expiry - today) / (1000 * 60 * 60 * 24)
    );

    if (member.whatsapp) {
      const number = member.whatsapp
        .replace(/^0/, "234")
        .replace(/\D/g, "");

      const message = encodeURIComponent(
        `MEMBERSHIP RENEWAL REMINDER 🚨

Hi! ${member.name}, Just a quick reminder that your gym membership expires TODAY.

⚠️ TODAY IS THE LAST DAY of your current *${member.plan}* subscription. To continue working out from tomorrow, you’ll need to renew your membership.

You can renew conveniently online here: 
Account name: Alpha Gym and more
Account number: 1029797162
Bank: UBA

Or make your payment at the front desk.

Alpha Gym Management.`
      );

      return res.json({
        whatsappUrl: `https://wa.me/${number}?text=${message}`,
      });
    }

    await sendReminder({
      name: member.name,
      email: member.email,
      plan: member.plan,
      expiry_date: member.expiry_date,
      daysLeft,
    });

    res.json({
      message: "Reminder sent via email",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to send reminder",
    });
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

      const daysLeft = Math.ceil(
        (expiry - today) / (1000 * 60 * 60 * 24)
      );

      if (member.whatsapp) {
        const number = member.whatsapp
          .replace(/^0/, "234")
          .replace(/\D/g, "");

        const message = encodeURIComponent(
          `MEMBERSHIP RENEWAL REMINDER 🚨

          Hi! ${member.name}, Just a quick reminder that your gym membership expires TODAY.

          ⚠️ TODAY IS THE LAST DAY of your current *${member.plan}* subscription. To continue working out from tomorrow, you’ll need to renew your membership.

          You can renew conveniently online here: 
          Account name: Alpha Gym and more
          Account number: 1029797162
          Bank: UBA

          Or make your payment at the front desk.

          Alpha Gym Management.`
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
    res.status(500).json({
      error: "Failed to send reminders",
    });
  }
});

export default router;