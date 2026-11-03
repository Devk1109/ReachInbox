import assert from "node:assert/strict";
import { test } from "node:test";
import { AesGcmSecretCipher } from "../../utils/secret-cipher";
import { classifySmtpError, SmtpEmailProvider, type SmtpTransportOptions } from "./email-provider";

const cipher = new AesGcmSecretCipher("cd".repeat(32));
const sender = {
  id: "sender-1",
  email: "sender@example.com",
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpUsername: "smtp-user",
  encryptedSmtpPassword: cipher.encrypt("smtp-password"),
};
const email = { id: "email-1", recipient: "recipient@example.com", subject: "Hello", body: "Test body" };

test("SMTP provider decrypts credentials, uses secure options, and reports accepted delivery", async () => {
  let observedOptions: SmtpTransportOptions | undefined;
  let observedMessage: { from: string; to: string; subject: string; text: string } | undefined;
  const provider = new SmtpEmailProvider(cipher, (options) => {
    observedOptions = options;
    return {
      async sendMail(message) {
        observedMessage = message;
        return { accepted: [email.recipient], messageId: "message-1" };
      },
    };
  });

  const result = await provider.send(email, sender);
  assert.deepEqual(result, { accepted: true, messageId: "message-1" });
  assert.equal(observedOptions?.auth.pass, "smtp-password");
  assert.equal(observedOptions?.secure, false);
  assert.equal(observedOptions?.disableFileAccess, true);
  assert.equal(observedOptions?.disableUrlAccess, true);
  assert.deepEqual(observedMessage, {
    from: sender.email,
    to: email.recipient,
    subject: email.subject,
    text: email.body,
  });
});

test("SMTP provider uses implicit TLS on port 465", async () => {
  let secure: boolean | undefined;
  const provider = new SmtpEmailProvider(cipher, (options) => {
    secure = options.secure;
    return { async sendMail() { return { accepted: [email.recipient] }; } };
  });
  await provider.send(email, { ...sender, smtpPort: 465 });
  assert.equal(secure, true);
});

test("SMTP error classification distinguishes transient, permanent, and ambiguous outcomes", () => {
  assert.equal(classifySmtpError({ code: "ETIMEDOUT", command: "CONNECT" }).retryable, true);
  assert.equal(classifySmtpError({ responseCode: 450, message: "try later" }).retryable, true);
  assert.equal(classifySmtpError({ responseCode: 450, command: "DATA" }).retryable, true);
  assert.equal(classifySmtpError({ responseCode: 550 }).retryable, false);
  assert.equal(classifySmtpError({ code: "ETIMEDOUT", command: "DATA" }).outcomeUnknown, true);
});

test("SMTP provider returns a permanent error when the recipient is not accepted", async () => {
  const provider = new SmtpEmailProvider(cipher, () => ({
    async sendMail() { return { accepted: [] }; },
  }));
  const result = await provider.send(email, sender);
  assert.equal(result.accepted, false);
  assert.equal(result.error?.retryable, false);
});
