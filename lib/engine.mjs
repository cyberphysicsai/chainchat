import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentCanonicalSkill, canonicalSkillEnvironment } from "./canonical-skill.mjs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const script = fileURLToPath(new URL("../engine_bridge.py", import.meta.url));
const preparationKey = randomBytes(32).toString('hex');
export async function engine(request, { signal, timeout = 180_000, mediaDirectory } = {}) {
  if (mediaDirectory !== undefined && (typeof mediaDirectory !== 'string' || !path.isAbsolute(mediaDirectory) || /[\0\r\n]/u.test(mediaDirectory)))
    throw Object.assign(new Error('The private source asset directory is invalid.'), { code: 'SOURCE_ASSET_INVALID', status: 422 });
  const bundle = await currentCanonicalSkill();
  const cancelled = () => Object.assign(new Error('Operation cancelled before completion. Verify the chain before retrying.'),
    { code: 'CANCELLED', status: 422 });
  if (signal?.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CT_CHAT_PYTHON ||
        (process.platform === "win32" ? "python" : "python3"),
      [script],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          ...canonicalSkillEnvironment(bundle),
          CT_CHAT_PREPARATION_KEY: preparationKey,
          CT_CHAT_MEDIA_ROOT: mediaDirectory || '',
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    let output = "";
    let diagnostics = "";
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (err) reject(err);
      else resolve(value);
    };
    const fail = (message, code = "ENGINE_ERROR") =>
      Object.assign(new Error(message), { code, status: 422 });
    const abort = () => {
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        fail(
          "The engine timed out. Verify the chain before retrying.",
          "ENGINE_TIMEOUT",
        ),
      );
    }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () =>
      finish(
        fail(
          "Python could not be started. Install Python 3.10+ or set CT_CHAT_PYTHON.",
          "PYTHON_UNAVAILABLE",
        ),
      ),
    );
    child.stdout.on("data", (b) => {
      output += b.toString("utf8");
      if (output.length > (request.op === 'read_source_asset' ? 32 : 24) * 1024 * 1024) {
        child.kill();
        finish(fail("Engine response exceeded the local transport limit."));
      }
    });
    child.stderr.on("data", (b) => {
      if (diagnostics.length < 4096) diagnostics += b.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.on("close", () => {
      if (done) return;
      if (signal?.aborted) return finish(cancelled());
      try {
        const value = JSON.parse(output);
        if (!value.ok) {
          const error = fail(
              value.error?.message || "The engine refused this operation.",
              value.error?.code || "ENGINE_REJECTED",
            );
          if (value.error?.code === "POI_REJECTED" && value.verdict && typeof value.verdict === "object")
            error.nativeVerdict = value.verdict;
          return finish(error);
        }
        finish(null, value);
      } catch {
        finish(
          fail(
            "The engine returned an invalid response. No generated answer was released.",
            "ENGINE_PROTOCOL",
          ),
        );
      }
    });
    if (signal?.aborted) abort();
    else child.stdin.end(JSON.stringify(request));
  });
}
