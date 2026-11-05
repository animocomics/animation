import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

async function encryptionKey(): Promise<Buffer> {
  const configured = process.env.NOMREH_SECRET_KEY;
  if (configured) return createHash("sha256").update(configured).digest();
  const [{ readFileSync, writeFileSync }, { default: path }, { DATA_DIRECTORY }] = await Promise.all([import("fs"), import("path"), import("./db")]);
  // Keep the existing key path so provider keys from earlier installations remain decryptable.
  const keyPath = path.join(DATA_DIRECTORY, ".provider-secret");
  try {
    return Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  } catch {
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    return key;
  }
}

export async function encryptSecret(value: string, purpose: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export async function decryptSecret(payload: string, purpose: string): Promise<string> {
  const [iv, tag, encrypted] = payload.split(".");
  if (!iv || !tag || !encrypted) throw new Error("فرمت رمز ذخیره‌شده معتبر نیست.");
  const decipher = createDecipheriv("aes-256-gcm", await encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
