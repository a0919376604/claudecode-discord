import { createSwitchBackendCommand } from "./switch-backend.js";

const { data, execute } = createSwitchBackendCommand("claude", "Claude");
export { data, execute };
