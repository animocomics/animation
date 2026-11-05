import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, isStrongEnoughPassword, verifyPassword } from "../lib/server/password";

test("password hashes are salted and verify without storing plaintext", () => {
  const first = hashPassword("Teacher@1405");
  const second = hashPassword("Teacher@1405");
  assert.notEqual(first, second);
  assert.equal(first.includes("Teacher@1405"), false);
  assert.equal(verifyPassword("Teacher@1405", first), true);
  assert.equal(verifyPassword("wrong-password", first), false);
  assert.equal(verifyPassword("Teacher@1405", "invalid"), false);
});

test("account passwords require letters and numbers", () => {
  assert.equal(isStrongEnoughPassword("Admin@1405"), true);
  assert.equal(isStrongEnoughPassword("onlyletters"), false);
  assert.equal(isStrongEnoughPassword("12345678"), false);
  assert.equal(isStrongEnoughPassword("Ab1"), false);
});
