import { chmod } from "node:fs/promises";

await chmod(new URL("../dist/bin/gconnect.js", import.meta.url), 0o755);
