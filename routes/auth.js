import express from "express";
import pool from "../db/index.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();

// Register
router.post("/register", async (req, res) => {
  const { gym_name, email, password } = req.body;

  if (!gym_name || !email || !password) {
    return res.status(400).json({ error: "Gym name, email and password are required" });
  }

  try {
    const exists = await pool.query(
      "SELECT * FROM gyms WHERE email = $1",
      [email]
    );
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO gyms (gym_name, email, password) VALUES ($1, $2, $3) RETURNING *",
      [gym_name, email, hashedPassword]
    );

    const gym = result.rows[0];

    const token = jwt.sign({ id: gym.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({
      token,
      gym: { id: gym.id, gym_name: gym.gym_name, email: gym.email },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM gyms WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const gym = result.rows[0];

    const isMatch = await bcrypt.compare(password, gym.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign({ id: gym.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      token,
      gym: { id: gym.id, gym_name: gym.gym_name, email: gym.email },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed" });
  }
});

export default router;