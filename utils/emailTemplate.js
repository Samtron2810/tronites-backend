// New-device login alert — fires when a login's User-Agent doesn't
// match any session already on file for that user (see
// utils/newDeviceAlert.js). Deliberately has no "click to secure your
// account" action link: this build has no session-scoped magic-link
// flow, so the actionable step is "go to Settings > Security and revoke
// it yourself if this wasn't you" rather than a token in the email.
export const newDeviceLoginTemplate = ({ device, ip, time }) => `
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

          <!-- Teal Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #1d9e75, #0f6e56); padding:32px 24px; text-align:center;">
              <h1 style="margin:0; font-size:28px; font-weight:800; color:#ffffff;">
                Tron<span style="color:#9fe1cb;">ites</span>
              </h1>
              <p style="margin:8px 0 0; font-size:14px; color:#e1f5ee;">New sign-in detected</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 24px;">
              <p style="margin:0 0 16px; font-size:16px; color:#374151;">Hello,</p>
              <p style="margin:0 0 20px; font-size:15px; color:#4b5563; line-height:1.6;">
                Your account was just signed in to from a device we haven't seen before.
              </p>

              <div style="background-color:#f9fafb; border:1px solid #e5e7eb; border-radius:12px; padding:18px 20px; margin-bottom:24px;">
                <p style="margin:0 0 8px; font-size:14px; color:#374151;"><strong>Device:</strong> ${device}</p>
                <p style="margin:0 0 8px; font-size:14px; color:#374151;"><strong>IP address:</strong> ${ip || "Unknown"}</p>
                <p style="margin:0; font-size:14px; color:#374151;"><strong>Time:</strong> ${time}</p>
              </div>

              <p style="margin:0 0 8px; font-size:13px; color:#6b7280;">
                If this was you, no action is needed. If you don't recognize this
                sign-in, go to Settings &gt; Security on Tronites and revoke the
                session, then change your password.
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

// Styled email template with Tronites branding (teal)
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

          <!-- Teal Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #1d9e75, #0f6e56); padding:32px 24px; text-align:center;">
              <h1 style="margin:0; font-size:28px; font-weight:800; color:#ffffff;">
                Tron<span style="color:#9fe1cb;">ites</span>
              </h1>
              <p style="margin:8px 0 0; font-size:14px; color:#e1f5ee;">Verify your email address</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 24px;">
              <p style="margin:0 0 16px; font-size:16px; color:#374151;">Hello,</p>
              <p style="margin:0 0 20px; font-size:15px; color:#4b5563; line-height:1.6;">
                Use the OTP below to complete your registration. This code is valid for
                <strong style="color:#0f6e56;">5 minutes</strong>.
              </p>

              <!-- OTP Box -->
              <div style="background-color:#e1f5ee; border:2px solid #9fe1cb; border-radius:12px; padding:20px; text-align:center; margin-bottom:24px;">
                <p style="margin:0 0 6px; font-size:13px; color:#085041; text-transform:uppercase; letter-spacing:1px;">One-Time Password</p>
                <p style="margin:0; font-size:36px; font-weight:700; color:#0f6e56; letter-spacing:8px;">${otp}</p>
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

// Password-reset variant — same Tronites branding, but the copy is
// specific to a reset request so recipients can tell this apart from a
// registration OTP at a glance. The "ignore if you didn't request this"
// line is important: it signals that a missed/suspicious reset attempt
// is actionable (change your password) rather than noise.
export const passwordResetEmailTemplate = (otp) => `
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

          <!-- Teal Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #1d9e75, #0f6e56); padding:32px 24px; text-align:center;">
              <h1 style="margin:0; font-size:28px; font-weight:800; color:#ffffff;">
                Tron<span style="color:#9fe1cb;">ites</span>
              </h1>
              <p style="margin:8px 0 0; font-size:14px; color:#e1f5ee;">Reset your password</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 24px;">
              <p style="margin:0 0 16px; font-size:16px; color:#374151;">Hello,</p>
              <p style="margin:0 0 20px; font-size:15px; color:#4b5563; line-height:1.6;">
                We received a request to reset your Tronites password. Use the code below to
                create a new one. This code is valid for
                <strong style="color:#0f6e56;">5 minutes</strong>.
              </p>

              <!-- OTP Box -->
              <div style="background-color:#e1f5ee; border:2px solid #9fe1cb; border-radius:12px; padding:20px; text-align:center; margin-bottom:24px;">
                <p style="margin:0 0 6px; font-size:13px; color:#085041; text-transform:uppercase; letter-spacing:1px;">Reset Code</p>
                <p style="margin:0; font-size:36px; font-weight:700; color:#0f6e56; letter-spacing:8px;">${otp}</p>
              </div>

              <p style="margin:0 0 8px; font-size:13px; color:#6b7280;">
                If you didn't request this, you can safely ignore this email. Your password won't change
                unless you enter this code.
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
