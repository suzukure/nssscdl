import { mountStudent } from "./view.js";
import { tokyoNowMonth } from "./model.js";
const root = document.getElementById("student");
if (root) {
  if (location.protocol !== "https:") root.textContent = "この画面はHTTPSの評価環境で開いてください。";
  else mountStudent(root, tokyoNowMonth(), fetch.bind(globalThis));
}
