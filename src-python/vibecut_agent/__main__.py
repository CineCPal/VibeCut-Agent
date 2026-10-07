import sys

from vibecut_agent.headless import main

if __name__ == "__main__":
    if sys.argv[1:] == ["mcp"]:
        # The MCP server (Phase 7a) speaks MCP on stdout, not the sidecar protocol, and is launched by
        # an MCP client, not by the app, so it isn't one of headless.COMMANDS.
        from vibecut_agent.mcp_server import main as mcp_main

        sys.exit(mcp_main())
    sys.exit(main(sys.argv[1:]))
