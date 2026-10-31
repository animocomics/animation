import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "plesk-git-maintenance.cjs");

function execute(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(repository: string, args: string[]) {
  return execute("git", ["-C", repository, ...args]);
}

function compact(repository: string) {
  return execute(process.execPath, [script], undefined, {
    ...process.env,
    NOMREH_GIT_DIR: repository,
    NOMREH_GIT_BRANCH: "main",
  });
}

function commitPayload(work: string, generation: number) {
  const content = Buffer.alloc(128 * 1024);
  for (let index = 0; index < content.length; index += 1) content[index] = (generation * 31 + index * 17) % 251;
  fs.writeFileSync(path.join(work, "payload.bin"), content);
  fs.writeFileSync(path.join(work, "version.txt"), `${generation}\n`);
  git(work, ["add", "payload.bin", "version.txt"]);
  git(work, ["commit", "-m", `generation ${generation}`]);
  git(work, ["push", "origin", "HEAD:main"]);
}

test("Plesk mirror maintenance caps repeated deployment history without changing remote or published files", { skip: process.platform === "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-git-maintenance-"));
  try {
    const work = path.join(directory, "work");
    const remote = path.join(directory, "remote.git");
    const mirror = path.join(directory, "mirror");
    fs.mkdirSync(work);
    git(work, ["init", "-q"]);
    git(work, ["config", "user.name", "Nomreh Test"]);
    git(work, ["config", "user.email", "nomreh-test@example.invalid"]);
    execute("git", ["init", "-q", "--bare", remote]);
    git(work, ["remote", "add", "origin", remote]);
    for (let generation = 1; generation <= 12; generation += 1) commitPayload(work, generation);

    execute("git", ["clone", "-q", "--branch", "main", `file://${remote}`, mirror]);
    assert.equal(Number(git(mirror, ["rev-list", "--count", "HEAD"])), 12);
    compact(mirror);
    assert.equal(git(mirror, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(fs.readFileSync(path.join(mirror, "version.txt"), "utf8"), "12\n");
    assert.equal(git(mirror, ["config", "--get", "core.logAllRefUpdates"]), "false");
    assert.equal(fs.existsSync(path.join(mirror, "logs")), false);
    assert.equal(git(remote, ["rev-list", "--count", "main"]), "12");

    commitPayload(work, 13);
    git(mirror, ["pull", "--no-rebase", "origin", "main"]);
    assert.ok(Number(git(mirror, ["rev-list", "--count", "HEAD"])) > 1);
    compact(mirror);
    assert.equal(git(mirror, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(fs.readFileSync(path.join(mirror, "version.txt"), "utf8"), "13\n");
    assert.equal(git(remote, ["rev-list", "--count", "main"]), "13");
    assert.match(git(mirror, ["status", "--short"]), /^$/);

    const bareMirror = path.join(directory, "bare.git");
    execute("git", ["clone", "-q", "--bare", "--branch", "main", `file://${remote}`, bareMirror]);
    assert.equal(Number(git(bareMirror, ["rev-list", "--count", "main"])), 13);
    compact(bareMirror);
    assert.equal(git(bareMirror, ["rev-list", "--count", "main"]), "1");
    assert.equal(fs.existsSync(path.join(bareMirror, "logs")), false);
    assert.equal(git(remote, ["rev-list", "--count", "main"]), "13");

    const home = path.join(directory, "home");
    const homeMirror = path.join(home, "git", "nomreh");
    fs.mkdirSync(path.dirname(homeMirror), { recursive: true });
    execute("git", ["clone", "-q", "--branch", "main", `file://${remote}`, homeMirror]);
    git(homeMirror, ["remote", "rename", "origin", "upstream"]);
    execute(process.execPath, [script], undefined, {
      ...process.env,
      HOME: home,
      NOMREH_GIT_DIR: "",
      NOMREH_GIT_BRANCH: "main",
    });
    assert.equal(git(homeMirror, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(fs.readFileSync(path.join(homeMirror, "version.txt"), "utf8"), "13\n");
    assert.equal(git(remote, ["rev-list", "--count", "main"]), "13");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
