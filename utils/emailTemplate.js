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

// Sent to an existing account owner when someone attempts to register
// with their email address. Anti-enumeration means we can't tell the
// registrant "that email is taken", so we notify the real owner instead
// so they're aware of the attempt and can act if needed.
export const duplicateRegistrationAlertTemplate = () => `
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
              <p style="margin:8px 0 0; font-size:14px; color:#e1f5ee;">Registration attempt on your account</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 24px;">
              <p style="margin:0 0 16px; font-size:16px; color:#374151;">Hello,</p>
              <p style="margin:0 0 20px; font-size:15px; color:#4b5563; line-height:1.6;">
                Someone just tried to create a new Tronites account using your email address.
                Because an account with this email already exists, no new account was created and
                no verification code was sent to them.
              </p>

              <div style="background-color:#fff8e1; border:1px solid #f6c90e; border-radius:12px; padding:18px 20px; margin-bottom:24px;">
                <p style="margin:0; font-size:14px; color:#7c6400; line-height:1.6;">
                  <strong>If this was you</strong> — you already have an account. Simply
                  <a href="https://tronites.com/login" style="color:#0f6e56; font-weight:600;">sign in</a>
                  or use <a href="https://tronites.com/forgot-password" style="color:#0f6e56; font-weight:600;">Forgot password</a>
                  if you've lost access.
                </p>
              </div>

              <p style="margin:0 0 8px; font-size:13px; color:#6b7280;">
                If this wasn't you, no action is needed — your account is safe and the
                registration attempt was blocked. If you're concerned, you can change
                your password at any time from Settings.
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

// Admin/moderator broadcast. `bodyHtml` is already escaped + paragraph-built
// by services/broadcastService.js#renderBodyHtml — never pass raw input here.
// `critical` swaps the unsubscribe footer for a "why you're receiving this"
// line, since critical notices intentionally ignore the opt-out flag.
//
// Gmail mobile auto-shrinks/narrows emails whose rendered HTML is short on
// content — short broadcasts were hitting that. Fixes applied:
//   1. Hidden preheader text (Gmail/Outlook preview-line filler, also pads
//      the DOM so Gmail doesn't treat the message as "thin").
//   2. outer table forced to 100% with a fixed-width inner table + MSO
//      conditional wrapper, so width is explicit instead of inferred.
//   3. Logo bar + divider + a denser footer give real height to short
//      one-paragraph bodies, instead of the body padding being the only
//      thing holding the card open.
//   4. min-height on the body card via a 1px spacer row — keeps the card
//      from collapsing to content height on short messages.
export const broadcastEmailTemplate = ({
  subject,
  bodyHtml,
  ctaLabel,
  ctaUrl,
  unsubscribeUrl,
  critical = false,
  preheader = "",
}) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${subject}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <style>table, td { border-collapse: collapse; }</style>
  <![endif]-->
</head>
<body style="margin:0; padding:0; background-color:#eef1f0; font-family:Arial, Helvetica, sans-serif; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
  <!-- Preheader: hidden preview text, also pads Gmail's content-length heuristic -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
    ${preheader || "A message from the Tronites team"}
    &#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f0;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!--[if mso]>
        <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td>
        <![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 16px rgba(15,110,86,0.08); border:1px solid #e5e7eb;">

          <!-- Logo bar -->
          <tr>
            <td align="center" style="padding:22px 24px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:20px; font-weight:800; color:#0f6e56; letter-spacing:-0.3px;">
                    Tron<span style="color:#1d9e75;">ites</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding:18px 24px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background: linear-gradient(135deg, #1d9e75, #0f6e56); border-radius:14px; padding:30px 28px; text-align:center;">
                    <p style="margin:0; font-size:11px; font-weight:700; color:#bdf0dd; text-transform:uppercase; letter-spacing:2px;">
                      ${critical ? "⚠ Important notice" : "📣 Announcement"}
                    </p>
                    <h1 style="margin:10px 0 0; font-size:22px; line-height:1.35; font-weight:800; color:#ffffff;">
                      ${subject}
                    </h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 28px 8px;">
              <div style="font-size:15px; color:#374151; line-height:1.7;">${bodyHtml}</div>
              ${
                ctaLabel && ctaUrl
                  ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
                       <tr>
                         <td style="border-radius:10px; background-color:#0f6e56;">
                           <a href="${ctaUrl}" style="display:inline-block; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px; padding:13px 28px;">${ctaLabel} &rarr;</a>
                         </td>
                       </tr>
                     </table>`
                  : ""
              }
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:16px 28px 0;">
              <div style="border-top:1px solid #eef1f0; line-height:0; font-size:0;">&nbsp;</div>
            </td>
          </tr>

          <!-- Secondary info strip — gives short messages real height and a reason to scroll past the fold -->
          <tr>
            <td style="padding:18px 28px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="40" valign="top" style="padding-right:12px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr><td width="32" height="32" align="center" valign="middle" style="background-color:#e1f5ee; border-radius:8px; font-size:15px;">💬</td></tr>
                    </table>
                  </td>
                  <td valign="top">
                    <p style="margin:0; font-size:13px; color:#6b7280; line-height:1.6;">
                      Questions about this message? Reach the Tronites team any time from
                      <a href="https://tronites.com/help" style="color:#0f6e56; font-weight:600; text-decoration:none;">Help &amp; Support</a>
                      inside the app.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb; padding:24px 28px; text-align:center; border-top:1px solid #e5e7eb;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 14px;">
                <tr>
                  <td style="padding:0 8px; font-size:13px; font-weight:700; color:#0f6e56;">
                    Tron<span style="color:#1d9e75;">ites</span>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px; font-size:12px; color:#9ca3af; line-height:1.6;">
                ${
                  critical
                    ? "You're receiving this because it affects your Tronites account."
                    : unsubscribeUrl
                      ? `Don't want these emails? <a href="${unsubscribeUrl}" style="color:#6b7280; text-decoration:underline;">Unsubscribe</a>`
                      : "You're receiving this as a Tronites member."
                }
              </p>
              <p style="margin:0; font-size:11px; color:#c1c7d0;">
                &copy; ${new Date().getFullYear()} Tronites. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
        <!--[if mso]>
        </td></tr></table>
        <![endif]-->

      </td>
    </tr>
  </table>
</body>
</html>
`;
