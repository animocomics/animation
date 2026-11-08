import assert from "node:assert/strict";
import test from "node:test";
import {
  DUPLICATE_WINDOW_MS,
  claimPaidRequest,
  duplicateKey,
  releasePaidRequest,
  resetPaidRequestClaims,
} from "../lib/server/duplicate-guard";

/**
 * The duplicate charge, stopped on the server.
 *
 * The panel can warn, but a second tab or a double POST never sees that warning.
 * One identical paid request inside the window must be refused here, where the
 * money is actually spent — and a request that provably cost nothing must not be
 * refused, or a teacher stays locked out of a sheet they never got billed for.
 */
test("the identical paid request is refused inside the window", () => {
  resetPaidRequestClaims();
  const key = duplicateKey(["question-import", "user_1", "exam_1", "gapgpt", "gpt-x", "file_a"]);
  assert.equal(claimPaidRequest(key), true, "first send must be allowed");
  assert.equal(claimPaidRequest(key), false, "the same send must not be billed twice");
  assert.equal(claimPaidRequest(key), false, "and a third click must not either");
});

test("a genuinely different request is not affected", () => {
  resetPaidRequestClaims();
  const first = duplicateKey(["question-import", "user_1", "exam_1", "gapgpt", "gpt-x", "file_a"]);
  assert.equal(claimPaidRequest(first), true);
  // Different file, different exam, or a different model is different paid work.
  assert.equal(claimPaidRequest(duplicateKey(["question-import", "user_1", "exam_1", "gapgpt", "gpt-x", "file_b"])), true);
  assert.equal(claimPaidRequest(duplicateKey(["question-import", "user_1", "exam_2", "gapgpt", "gpt-x", "file_a"])), true);
  assert.equal(claimPaidRequest(duplicateKey(["question-import", "user_1", "exam_1", "gapgpt", "gpt-y", "file_a"])), true);
  // Another teacher must never be blocked by someone else's send.
  assert.equal(claimPaidRequest(duplicateKey(["question-import", "user_2", "exam_1", "gapgpt", "gpt-x", "file_a"])), true);
});

test("the window expires, so a deliberate retry after a failure still works", () => {
  resetPaidRequestClaims();
  const key = duplicateKey(["k"]);
  const start = 1_000_000;
  assert.equal(claimPaidRequest(key, start), true);
  assert.equal(claimPaidRequest(key, start + DUPLICATE_WINDOW_MS - 1), false);
  assert.equal(claimPaidRequest(key, start + DUPLICATE_WINDOW_MS + 1), true, "after the window a human retry is allowed");
});

test("a request that cost nothing releases its claim", () => {
  resetPaidRequestClaims();
  const key = duplicateKey(["question-import", "user_1", "exam_1", "gapgpt", "gpt-x", "file_a"]);
  assert.equal(claimPaidRequest(key), true);
  // The provider rejected the key/base URL before inference: no bill, no lock-out.
  releasePaidRequest(key);
  assert.equal(claimPaidRequest(key), true);
});

test("the guard is bounded: expired claims are dropped, not accumulated", () => {
  resetPaidRequestClaims();
  const start = 2_000_000;
  for (let index = 0; index < 50; index += 1) claimPaidRequest(duplicateKey(["k", index]), start);
  // A later claim sweeps the expired ones instead of growing without limit.
  assert.equal(claimPaidRequest(duplicateKey(["k", "later"]), start + DUPLICATE_WINDOW_MS + 10), true);
  assert.equal(claimPaidRequest(duplicateKey(["k", 0]), start + DUPLICATE_WINDOW_MS + 10), true, "an expired key is reusable");
});
