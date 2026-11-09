package line

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"
)

// 発言の分類と文面の加工。cc-connect 1.5.0 の文面（core/i18n.go）と、
// 承認の解釈（core/engine.go の matchPermissionKeyword）に合わせている。

// approvalWord は、承認の返事として受け付ける発言を cc-connect に渡す形へ直す。
// 発言全体がその語だけのときに限る（docs/line-adapter.md）。
func approvalWord(text string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "allow", "許可":
		return "allow", true
	case "deny", "拒否":
		return "deny", true
	}
	return "", false
}

var (
	approveAllPhrases = [][]string{{"allow", "all"}, {"approve", "all"}, {"yes", "all"}}
	approveAllTokens  = []string{"allowall", "允许所有", "允许全部", "全部允许", "所有允许", "都允许", "全部同意"}
)

// isApproveAll は、cc-connect が「allow all」とみなす発言かを返す。
func isApproveAll(text string) bool {
	tokens := permissionTokens(text)
	for _, ph := range approveAllPhrases {
		for i := 0; i+len(ph) <= len(tokens); i++ {
			if slices.Equal(tokens[i:i+len(ph)], ph) {
				return true
			}
		}
	}
	return slices.ContainsFunc(tokens, func(t string) bool { return slices.Contains(approveAllTokens, t) })
}

// isApproveAllWord は、発言の全体が「allow all」の言い方かを返す（メンションなしの発言に使う）。
func isApproveAllWord(text string) bool {
	tokens := permissionTokens(text)
	return slices.ContainsFunc(approveAllPhrases, func(ph []string) bool { return slices.Equal(tokens, ph) }) ||
		len(tokens) == 1 && slices.Contains(approveAllTokens, tokens[0])
}

// permissionTokens は、文字・数字以外で区切り、小文字にする。cc-connect の splitPermissionTokens は
// 空白と一部の記号だけで区切る。こちらはその上位集合で区切るので、cc-connect が allow all とみなす
// 発言は必ず検出できる（多めに検出することはある）。
func permissionTokens(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
}

type outgoingKind int

const (
	kindAnswer           outgoingKind = iota // 通常の返事
	kindPermissionPrompt                     // 承認依頼
	kindQuestion                             // Claude からの質問（AskUserQuestion）
	kindPermissionHint                       // 承認待ちの間の案内
	kindHelper                               // 「✅ 許可しました」などの補助的な発言
	kindQueued                               // 「📬 メッセージを受信しました」（順番待ちの受け付け）
)

// classify は、cc-connect から届いた文面の種類を見分ける（日本語と英語の文面）。
func classify(content string) outgoingKind {
	c := strings.TrimSpace(content)
	hasPrefix := func(prefixes ...string) bool {
		return slices.ContainsFunc(prefixes, func(p string) bool { return strings.HasPrefix(c, p) })
	}
	switch {
	case hasPrefix("⚠️ **権限リクエスト**", "⚠️ **Permission Request**"):
		return kindPermissionPrompt
	case hasPrefix("⚠️ 権限の応答を待っています", "⚠️ Waiting for permission response"):
		return kindPermissionHint
	case hasPrefix("✅ 許可しました", "✅ Allowed, continuing", "❌ 拒否しました", "❌ Denied.",
		"✅ このセッションの全ての権限を自動承認", "✅ All permissions auto-approved"):
		return kindHelper
	case hasPrefix("📬 メッセージを受信しました", "📬 Message received"):
		return kindQueued
	case strings.Contains(c, "エージェントの質問"), strings.Contains(c, "Agent Question"):
		return kindQuestion
	}
	return kindAnswer
}

var allowAllRemover = strings.NewReplacer(
	" / **allow all**（このセッション中は全て自動許可）", "",
	" / **allow all** (skip all future prompts this session)", "",
	" / **allow all**", "",
)

// withoutAllowAll は、承認依頼と案内の文面から allow all の選択肢を消す（このルームでは使えないため）。
func withoutAllowAll(content string) string { return allowAllRemover.Replace(content) }

// stripSelfMentions は、本文から Bot へのメンション部分を取り除く。
// LINE の index と length は UTF-16 の単位で数える。
func stripSelfMentions(text string, mentions []mentionee) string {
	u := utf16.Encode([]rune(text))
	remove := make([]bool, len(u))
	for _, m := range mentions {
		if !m.IsSelf || m.Index < 0 || m.Length <= 0 || m.Index+m.Length > len(u) {
			continue
		}
		for i := m.Index; i < m.Index+m.Length; i++ {
			remove[i] = true
		}
	}
	kept := make([]uint16, 0, len(u))
	for i, c := range u {
		if !remove[i] {
			kept = append(kept, c)
		}
	}
	return strings.TrimSpace(string(utf16.Decode(kept)))
}

const (
	maxBubbles     = 5    // 1 回の送信に入れられる吹き出しの数
	maxBubbleChars = 5000 // 吹き出し 1 つの最大文字数（UTF-16 の単位で数える）
	truncatedNote  = "\n\n（長すぎるため、ここから先は省略しました）"
)

var truncatedNoteLen = len(utf16.Encode([]rune(truncatedNote)))

// splitBubbles は、本文を最大 5 つの吹き出しに分ける。入りきらない分は切り、省略したことを書き添える。
func splitBubbles(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	runes := []rune(text)
	var out []string
	for len(runes) > 0 && len(out) < maxBubbles {
		n := fitUTF16(runes, maxBubbleChars)
		out = append(out, string(runes[:n]))
		runes = runes[n:]
	}
	if len(runes) > 0 {
		last := []rune(out[len(out)-1])
		n := fitUTF16(last, maxBubbleChars-truncatedNoteLen)
		out[len(out)-1] = string(last[:n]) + truncatedNote
	}
	return out
}

// fitUTF16 は、UTF-16 で limit 単位に収まる先頭の rune 数を返す。
func fitUTF16(runes []rune, limit int) int {
	units := 0
	for i, r := range runes {
		w := utf16.RuneLen(r)
		if w < 0 {
			w = 1
		}
		if units+w > limit {
			return i
		}
		units += w
	}
	return len(runes)
}
