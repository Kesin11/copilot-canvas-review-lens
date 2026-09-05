import { joinSession } from "@github/copilot-sdk/extension";
import { canvas } from "./canvas.mjs";
import { setRuntimeSession } from "./server.mjs";

const runtimeSession = await joinSession({ canvases: [canvas] });
setRuntimeSession(runtimeSession);
