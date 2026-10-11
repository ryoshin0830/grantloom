import { spawn } from "node:child_process";
import { AppError } from "./errors.js";
export async function runOp(args, { env = process.env, tokenEnv, input } = {}) {
  if (
    tokenEnv !== undefined &&
    (typeof tokenEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv) ||
      !env[tokenEnv])
  )
    throw new AppError("OP_FAILED");
  const childEnv = { ...env };
  if (tokenEnv) childEnv.OP_SERVICE_ACCOUNT_TOKEN = env[tokenEnv];
  return new Promise((resolve, reject) => {
    const child = spawn("op", args, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let size = 0;
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      reject(new AppError("OP_FAILED"));
    };
    const timer = setTimeout(fail, 30000);
    timer.unref();
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) fail();
      else output += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (finished) return;
      if (code !== 0) return fail();
      try {
        const parsed = JSON.parse(output);
        finished = true;
        resolve(parsed);
      } catch {
        fail();
      }
    });
    try {
      child.stdin.end(input === undefined ? "" : JSON.stringify(input));
    } catch {
      fail();
    }
  });
}
export async function callOp(op, args, options) {
  try {
    return await op(args, options);
  } catch {
    throw new AppError("OP_FAILED");
  }
}
