import express from "express";
import pool from "../db/index.js";
import protect from "../middleware/auth.js";

const router = express.Router();

// Get all plans for this gym
router.get("/", protect, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM plans WHERE gym_id = $1 ORDER BY amount ASC",
      [req.gymId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});

// Create a plan
router.post("/", protect, async (req, res) => {
  const { name, duration_days, amount } = req.body;

  if (!name || !duration_days || !amount) {
    return res.status(400).json({ error: "Name, duration and amount are required" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO plans (gym_id, name, duration_days, amount) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.gymId, name, duration_days, amount]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create plan" });
  }
});

// Update a plan
router.patch("/:id", protect, async (req, res) => {
  const { name, duration_days, amount } = req.body;

  try {
    const result = await pool.query(
      `UPDATE plans SET name = $1, duration_days = $2, amount = $3
       WHERE id = $4 AND gym_id = $5 RETURNING *`,
      [name, duration_days, amount, req.params.id, req.gymId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Plan not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update plan" });
  }
});

// Delete a plan
router.delete("/:id", protect, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM plans WHERE id = $1 AND gym_id = $2",
      [req.params.id, req.gymId]
    );
    res.json({ message: "Plan deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete plan" });
  }
});

export default router;
