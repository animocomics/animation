import assert from "node:assert/strict";
import test from "node:test";
import { isParameterRejection } from "../lib/server/providers";

/**
 * The retry that saves a paid request.
 *
 * A gateway that refuses one optional field (`response_format`, `max_tokens`,
 * `temperature`, per-image `detail`) answers 400 before inference, after the page
 * images were uploaded and often already counted. The importer used to surface that
 * as a dead end, so the teacher's next action was to resend the same sheet and pay
 * again. One bounded retry with the plainest body fixes the field case — and it must
 * never fire for the cases where resending is pure waste.
 */
test("an unsupported-parameter 400 is retried, not reported", () => {
  assert.equal(isParameterRejection(400, "Unsupported parameter: 'response_format' is not supported for this model."), true);
  assert.equal(isParameterRejection(400, "Invalid value: 'detail' is not supported for this model."), true);
  assert.equal(isParameterRejection(400, "max_tokens is too large for this model"), true);
  assert.equal(isParameterRejection(422, "unknown field temperature"), true);
});

test("failures that mean the request itself is wrong are not resent", () => {
  // Not a parameter problem: resending would only duplicate the bill.
  assert.equal(isParameterRejection(400, ""), false);
  assert.equal(isParameterRejection(401, "API key is not valid."), false);
  assert.equal(isParameterRejection(402, "Insufficient credit."), false);
  assert.equal(isParameterRejection(429, "Rate limit reached."), false);
  assert.equal(isParameterRejection(502, "upstream unavailable"), false);
  assert.equal(isParameterRejection(500, "response_format exploded"), false);
});
