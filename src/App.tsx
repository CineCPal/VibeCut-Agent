import { useEffect } from "react";
import { AboutModal } from "./components/about/AboutModal";
import { AppShell } from "./components/layout/AppShell";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { useAgent } from "./hooks/useAgent";
import { startChatHistory } from "./lib/agent/chatHistory";
import { startChatTitles } from "./lib/agent/chatTitles";
import { startBrollPanelBridge } from "./lib/brollPanel";
import { startMcpBridge } from "./lib/mcp/server";
import { useHotkeys } from "./hooks/useHotkeys";
import { useKeepOnTop } from "./hooks/useKeepOnTop";
import { useNavigateListener } from "./hooks/useNavigateListener";
import { useNleBridge } from "./hooks/useNleBridge";
import { useSidecarBridge } from "./hooks/useSidecarBridge";
import { useSystemStore } from "./store/useSystemStore";
import { useUiStore } from "./store/useUiStore";

function App() {
  const overlay = useUiStore((s) => s.overlay);
  const closeOverlay = useUiStore((s) => s.closeOverlay);
  const refreshSystem = useSystemStore((s) => s.refresh);

  useNavigateListener();
  useSidecarBridge();
  useNleBridge();
  useKeepOnTop();
  useAgent();
  useHotkeys();

  useEffect(() => {
    void refreshSystem();
  }, [refreshSystem]);

  // The B-roll panel docked in Premiere (lib/brollPanel.ts).
  useEffect(() => startBrollPanelBridge(), []);

  // Past chats and the edit log, saved and restored across restarts (lib/agent/chatHistory.ts).
  useEffect(() => startChatHistory(), []);
  useEffect(() => startChatTitles(), []);

  // The MCP bridge: Claude Code calling the agent's tools (lib/mcp/server.ts).
  useEffect(() => startMcpBridge(), []);

  return (
    <>
      <AppShell />
      {overlay === "settings" ? <SettingsPanel onClose={closeOverlay} /> : null}
      {overlay === "about" ? <AboutModal onClose={closeOverlay} /> : null}
    </>
  );
}

export default App;
