# agent-chat-relay

業務チャット（LINE・LINE WORKS・Chatwork・Discord）と、コーディングエージェントの間を中継する薄い層。自作の中核が ACP（Agent Client Protocol）でハーネス（Claude Code、OpenCode など）を動かし、MCP の道具でルームの読み書きを渡す。判断の経緯は `docs/adr/` にある（ADR 0006）。

当初は cc-connect の外部アダプターとして作っていた。その実装は `old/` に残している。
