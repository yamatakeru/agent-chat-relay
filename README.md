# cc-connect-jtc-adapters

LINE・LINE WORKS・Chatwork・Discord のルームから、コーディングエージェントに依頼するための接続部分。自作の中核が ACP（Agent Client Protocol）でハーネス（Claude Code、OpenCode など）を動かし、MCP の道具でルームの読み書きを渡す。判断の経緯は `docs/adr/` にある（ADR 0006）。

当初は cc-connect の外部アダプターとして作っていた。その実装は `old/` に残している。
