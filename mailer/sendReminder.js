import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const sendReminder = async ({ name, email, plan, expiry_date, daysLeft }) => {
  // Skip if no email
  if (!email) {
    console.log(`Skipping reminder for ${name} — no email on file`);
    return;
  }

  await resend.emails.send({
    from: "Alpha Gym <onboarding@resend.dev>",
    to: email,
    subject: `⚠️ Your ${plan} membership expires in ${daysLeft} day${daysLeft > 1 ? "s" : ""}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #000; padding: 24px; text-align: center;">
          <h1 style="color: #facc15; margin: 0;">Alpha Gym</h1>
        </div>
        <div style="padding: 32px; background: #fff;">
          <h2>Hey ${name} 👋</h2>
          <p style="color: #555; font-size: 16px;">
            Your <strong>${plan}</strong> membership expires in 
            <strong style="color: #ca8a04;">${daysLeft} day${daysLeft > 1 ? "s" : ""}</strong> 
            on <strong>${new Date(expiry_date).toDateString()}</strong>.
          </p>
          <p style="color: #555; font-size: 16px;">
            Renew now to keep your access 💪
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${process.env.FRONTEND_URL}"
              style="background: #facc15; color: #000; padding: 14px 32px; 
                     border-radius: 50px; text-decoration: none; font-weight: bold;">
              Renew Membership
            </a>
          </div>
          <p style="color: #999; font-size: 13px; text-align: center;">
            If you have already renewed, please ignore this email.
          </p>
        </div>
      </div>
    `,
  });
};

export default sendReminder;