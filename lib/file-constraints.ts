export const ACCEPTED_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
/** Base64 adds roughly one third to the binary size; leave room for a 100 MiB file. */
export const MAX_FILE_BASE64_LENGTH = 140_000_000;
export const MAX_FILE_SIZE_LABEL = "۱۰۰ مگابایت";
