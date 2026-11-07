package line

import (
	"strings"
	"testing"
	"unicode/utf16"
)

func TestApprovalWord(t *testing.T) {
	for in, want := range map[string]string{"allow": "allow", " ALLOW ": "allow", "許可": "allow", "deny": "deny", "拒否": "deny", "ok": "", "allow it": ""} {
		got, ok := approvalWord(in)
		if got != want || ok != (want != "") {
			t.Errorf("approvalWord(%q) = %q, %v", in, got, ok)
		}
	}
}

func TestIsApproveAll(t *testing.T) {
	for in, want := range map[string]bool{
		"allow all": true, "Allow  All": true, "please approve all now": true, "yes all": true,
		"allowall": true, "全部允许": true, "allow-all": true,
		"allow": false, "all good": false, "allow everything later": false,
	} {
		if got := isApproveAll(in); got != want {
			t.Errorf("isApproveAll(%q) = %v", in, got)
		}
	}
}

func TestIsApproveAllWord(t *testing.T) {
	for in, want := range map[string]bool{
		"allow all": true, " Allow All! ": true, "approve all": true, "allowall": true, "全部允许": true,
		"please approve all now": false, "allow": false, "all": false,
	} {
		if got := isApproveAllWord(in); got != want {
			t.Errorf("isApproveAllWord(%q) = %v", in, got)
		}
	}
}

func TestClassify(t *testing.T) {
	for in, want := range map[string]outgoingKind{
		permissionPrompt: kindPermissionPrompt,
		"⚠️ 権限の応答を待っています。**allow** / **deny** / **allow all** で返信してください。": kindPermissionHint,
		"✅ 許可しました。続行中...":                 kindHelper,
		"❌ 拒否しました。エージェントはこのツールの使用を中止します。": kindHelper,
		"**エージェントの質問**\n\nどれ？":            kindQuestion,
		"ふつうの答え":       kindAnswer,
		"✅ どちら: **A**": kindAnswer,
		"📬 メッセージを受信しました。現在のタスク完了後に処理します。":          kindQueued,
		"📬 メッセージキューが満杯です（3 件待ち）。現在のタスク完了をお待ちください。": kindAnswer,
	} {
		if got := classify(in); got != want {
			t.Errorf("classify(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestWithoutAllowAll(t *testing.T) {
	got := withoutAllowAll(permissionPrompt)
	if strings.Contains(got, "allow all") || !strings.Contains(got, "**allow** / **deny**で返信してください。") {
		t.Errorf("unexpected: %q", got)
	}
}

func TestStripSelfMentionsUsesUTF16(t *testing.T) {
	// 絵文字（UTF-16 で 2 単位）の後ろにあるメンションを取り除く
	text := "😀 @Bot 調べて @Alice"
	mentions := []mentionee{
		{Index: 3, Length: 4, IsSelf: true},
		{Index: 11, Length: 6, IsSelf: false},
	}
	if got := stripSelfMentions(text, mentions); got != "😀  調べて @Alice" {
		t.Errorf("got %q", got)
	}
}

func TestSplitBubbles(t *testing.T) {
	if got := splitBubbles("  hi  "); len(got) != 1 || got[0] != "hi" {
		t.Errorf("short: %q", got)
	}
	long := strings.Repeat("あ", maxBubbleChars*2+10)
	if got := splitBubbles(long); len(got) != 3 || len([]rune(got[0])) != maxBubbleChars {
		t.Errorf("long: %d bubbles", len(got))
	}
	tooLong := strings.Repeat("😀", maxBubbleChars*3) // UTF-16 で 2 単位ずつ
	got := splitBubbles(tooLong)
	if len(got) != maxBubbles || !strings.HasSuffix(got[maxBubbles-1], truncatedNote) {
		t.Fatalf("too long: %d bubbles", len(got))
	}
	for i, b := range got {
		if n := len(utf16.Encode([]rune(b))); n > maxBubbleChars {
			t.Errorf("bubble %d has %d UTF-16 units", i, n)
		}
	}
}
