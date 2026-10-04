import cron from "node-cron";
import pool from "../db/index.js";
import sendReminder from "../mailer/sendReminder.js";

const startReminderJob = () => {
  // Runs every day at 9am
  cron.schedule("0 9 * * *", async () => {
    console.log("Running daily membership check...");

    try {
      // Auto expire members whose expiry date has passed
      const expired = await pool.query(
        `UPDATE members 
         SET status = 'expired'
         WHERE status = 'active'
         AND expiry_date < CURRENT_DATE
         RETURNING id, name, email`
      );

      if (expired.rows.length > 0) {
        console.log(`Auto expired ${expired.rows.length} members`);
      }

      // Archive members who have remained expired for at least 15 days.
      // The DELETE + INSERT runs as one database statement, so a member is
      // never removed from members unless the archive insert succeeds.
      const archived = await pool.query(
        `WITH moved AS (
           DELETE FROM members
           WHERE status = 'expired'
           AND expiry_date <= CURRENT_DATE - INTERVAL '15 days'
           RETURNING *
         )
         INSERT INTO member_archive
         SELECT moved.*, NOW(), 'membership_expired_15_days'
         FROM moved
         RETURNING id, name, gym_id`
      );

      if (archived.rows.length > 0) {
        console.log(`Archived ${archived.rows.length} members expired 15+ days`);
      }

      // Send reminders to members expiring in 7 days or less
      const result = await pool.query(
        `SELECT * FROM members 
         WHERE status = 'active'
         AND expiry_date BETWEEN CURRENT_DATE + INTERVAL '1 day' 
         AND CURRENT_DATE + INTERVAL '7 days'`
      );

      const members = result.rows;
      console.log(`Found ${members.length} members expiring soon`);

      for (const member of members) {
        const expiry = new Date(member.expiry_date);
        const today = new Date();
        const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

        await sendReminder({
          name: member.name,
          email: member.email,
          plan: member.plan,
          expiry_date: member.expiry_date,
          daysLeft,
        });

        console.log(`Reminder sent to ${member.email}`);
      }
    } catch (error) {
      console.error("Cron job error:", error);
    }
  });

  console.log("Reminder cron job started");
};

export default startReminderJob;
