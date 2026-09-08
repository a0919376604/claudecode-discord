import { createSwitchBackendCommand } from "./switch-backend.js";

const { data, execute } = createSwitchBackendCommand("codex", "Codex");
export { data, execute };
