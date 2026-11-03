import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class AesGcmSecretCipher {
  private readonly key: Buffer | undefined;

  constructor(keyHex?: string) {
    if (keyHex && !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error("Encryption key must be exactly 32 bytes encoded as 64 hex characters");
    }
    this.key = keyHex ? Buffer.from(keyHex, "hex") : undefined;
  }

  encrypt(plaintext: string): string {
    const key = this.getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(encoded: string): string {
    const key = this.getKey();
    const [version, ivValue, tagValue, ciphertextValue, extra] = encoded.split(".");
    if (version !== "v1" || !ivValue || !tagValue || ciphertextValue === undefined || extra !== undefined) {
      throw new Error("Encrypted secret has an invalid format");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private getKey(): Buffer {
    if (!this.key) throw new Error("ENCRYPTION_KEY must be configured before encrypting credentials");
    return this.key;
  }
}
