// Styled email template with Tronites branding (orange + blue)
export const otpEmailTemplate = (otp) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0; padding:0; background-color:#f5f5f5; font-family:Arial, Helvetica, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5; padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
          
          <!-- Orange Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #f97316, #ea580c); padding:32px 24px; text-align:center;">
              <h1 style="margin:0; font-size:28px; font-weight:800; color:#ffffff;">
                Tron<span style="color:#60a5fa;">ites</span>
              </h1>
              <p style="margin:8px 0 0; font-size:14px; color:#ffedd5;">Verify your email address</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 24px;">
              <p style="margin:0 0 16px; font-size:16px; color:#374151;">Hello,</p>
              <p style="margin:0 0 20px; font-size:15px; color:#4b5563; line-height:1.6;">
                Use the OTP below to complete your registration. This code is valid for
                <strong style="color:#f97316;">5 minutes</strong>.
              </p>

              <!-- OTP Box -->
              <div style="background-color:#fff7ed; border:2px solid #fed7aa; border-radius:12px; padding:20px; text-align:center; margin-bottom:24px;">
                <p style="margin:0 0 6px; font-size:13px; color:#9a3412; text-transform:uppercase; letter-spacing:1px;">One-Time Password</p>
                <p style="margin:0; font-size:36px; font-weight:700; color:#3b82f6; letter-spacing:8px;">${otp}</p>
              </div>

              <p style="margin:0 0 8px; font-size:13px; color:#6b7280;">
                If you didn't request this, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb; padding:20px 24px; text-align:center; border-top:1px solid #e5e7eb;">
              <p style="margin:0; font-size:13px; color:#9ca3af;">
                &copy; ${new Date().getFullYear()} Tronites. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
