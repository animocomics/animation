/**
 * The one place that states what may be uploaded.
 *
 * Before this, four screens each carried their own copy of the accepted list, so the
 * answer to "what files does this accept?" depended on which box a teacher happened
 * to open, and a change to the server's list could silently disagree with the UI.
 */
export const ACCEPTED_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

/** Extensions for `<input accept>`; keep in step with ACCEPTED_FILE_TYPES. */
export const ACCEPTED_FILE_EXTENSIONS = ".jpg,.jpeg,.png,.webp,.pdf";

/** Human-readable list shown to the teacher, in the same order as the picker. */
export const ACCEPTED_FILE_LABEL = "JPG، JPEG، PNG، WebP، PDF";

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
/** Base64 adds roughly one third to the binary size; leave room for a 100 MiB file. */
export const MAX_FILE_BASE64_LENGTH = 140_000_000;
export const MAX_FILE_SIZE_LABEL = "۱۰۰ مگابایت";
