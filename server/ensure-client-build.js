import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, "..");
const clientDir = path.join(root, "client");

const dist = path.join(clientDir, "dist");
const indexHtml = path.join(dist, "index.html");

console.log("[ensure-build] root =", root);
console.log("[ensure-build] clientDir =", clientDir);
console.log("[ensure-build] indexHtml =", indexHtml, "exists =", fs.existsSync(indexHtml));

if (!fs.existsSync(indexHtml)) {
  console.log("[ensure-build] client/dist missing -> building client...");
  execSync("npm install --include=dev", { stdio: "inherit", cwd: clientDir, shell: true });
  execSync("npm run build", { stdio: "inherit", cwd: clientDir, shell: true });
  console.log("[ensure-build] build done. exists =", fs.existsSync(indexHtml));
} else {
  console.log("[ensure-build] client already built.");
}
